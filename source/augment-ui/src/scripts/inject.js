const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const appDir = path.join(__dirname, "../../");
const buildIndex = path.join(appDir, "build/index.html");
const outputFilePath = path.join(appDir, "build/worker-template.liquid.html");
const encoding = { encoding: "utf8" };

// We have a valid html file parsed and we want to replace special hidden
// input elements' data-src attributes to point to a liquid tag instead.
//
// Unfotunately, we can't directly set the attribute in JSDOM since we
// need to inject un-escaped quotes to form literals in liquid tags.
//
// For example,
// <input data-src="s3://frontend/myFile" /> is converted to
// <input data-src="{{ "s3://frontend/myFile" | grant_read_access }} />
//
// The element with liquid injection is no longer valid html.
//
// Instead of directly setting the attribute, during parsing we stick
// a unique token in each field, then run a simple find and replace
// on the tokens on the raw string to add the liquid tags before writing
// the worker template out to file.

const liquifyVar = (obj) => {
  return `{{ ${obj} | to_json | escape }}`;
};

const liquifyS3File = (obj, isLiteral = true) => {
  const formatObj = isLiteral ? `'${obj}'` : obj;
  return `{{ ${formatObj} | grant_read_access }}`;
};

const liquifyFrontendUri = (uri, s3Prefix) => {
  const s3Url = new URL(s3Prefix);
  s3Url.pathname = path.posix.join(s3Url.pathname, uri);
  const combinedUri = s3Url.href;
  return liquifyS3File(combinedUri);
};

const buildWorkerTemplate = (inputHtmlStr, s3Prefix) => {
  const dom = new JSDOM(inputHtmlStr);
  const doc = dom.window.document;

  const tokenReplaceMap = {};

  const replacementToken = (element, liquidValue) => {
    const md5 = crypto.createHash("md5");
    md5.update(element.outerHTML);
    const token = md5.digest("hex");
    tokenReplaceMap[token] = liquidValue;
    return token;
  };

  Array.from(doc.querySelectorAll("link")).forEach((el) => {
    el.href = replacementToken(el, liquifyFrontendUri(el.href, s3Prefix));
  });

  Array.from(doc.querySelectorAll("script[src]")).forEach((el) => {
    // Skip injecting HITL tag if we're pulling an external source
    if (el.src.startsWith("http")) {
      return;
    }
    el.src = replacementToken(el, liquifyFrontendUri(el.src, s3Prefix));
  });

  Array.from(doc.querySelectorAll("input.asset")).forEach((el) => {
    el.setAttribute(
      "data-src",
      replacementToken(
        el,
        liquifyFrontendUri(el.getAttribute("data-src"), s3Prefix)
      )
    );
  });

  Array.from(doc.querySelectorAll("input.s3-file")).forEach((el) => {
    const dataSrc = el.getAttribute("data-src");
    const isLiteral = dataSrc.startsWith("s3://");
    const liquid = liquifyS3File(dataSrc, isLiteral);
    el.setAttribute("data-src", replacementToken(el, liquid));
    // No need to keep around attributes for local development.
    el.removeAttribute("data-local");
  });

  Array.from(doc.querySelectorAll("input.json-var")).forEach((el) => {
    el.setAttribute(
      "data-src",
      replacementToken(el, liquifyVar(el.getAttribute("data-src")))
    );
    // No need to keep around attributes for local development.
    el.removeAttribute("data-local");
  });

  const tokenIndexHtml = dom.serialize();

  let liquidIndexHtml = tokenIndexHtml;
  for (const [token, liquidTag] of Object.entries(tokenReplaceMap)) {
    liquidIndexHtml = liquidIndexHtml.replace(token, liquidTag);
  }

  return liquidIndexHtml;
};

const runMain = () => {
  // S3Prefix is the s3 path the frontend build is deployed at. It's used for referring
  // to assets that ship with the frontend build (items in public/).
  const s3Prefix = process.env.S3_PREFIX;

  if (!s3Prefix) {
    console.log(
      "Couldn't read S3_PREFIX env variable, please set it and re-run"
    );
    // Exit with error code.
    process.exit(1);
  }

  const indexHtmlStr = fs.readFileSync(buildIndex, encoding);
  const liquidIndexHtml = buildWorkerTemplate(indexHtmlStr, s3Prefix);

  fs.writeFileSync(outputFilePath, liquidIndexHtml);
  console.log(`Wrote ${outputFilePath}`);
};

if (require.main === module) {
  runMain();
}

module.exports = { buildWorkerTemplate };
