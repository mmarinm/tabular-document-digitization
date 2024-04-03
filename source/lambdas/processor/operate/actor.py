# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

from shared.defines import *
from shared.environ import *
from shared.helpers import GetCurrentStamp
from shared.loggers import Logger

from shared.document import Document
from shared.storage  import S3Uri
from shared.message  import Message
from shared.bus      import Bus

from traceback import print_exc
from typing    import List

def lambda_handler(event, context):

    document = Document.from_dict(event)
    message  = Message(DocumentID = document.DocumentID)

    Logger.info(f'{STAGE} Actor : Started Processing DocumentID = {document.DocumentID}')
    
    
    sourceS3Uri = S3Uri(Bucket = STORE_BUCKET, Object = f'{document.ExtractMap.StageS3Uri.Prefix}.json')
    outputS3Uri = S3Uri(Bucket = STORE_BUCKET, Object = f'{STAGE}/{document.DocumentID}/humanInTheLoop-Operated.json')

    try:

        hil_document = sourceS3Uri.GetJSON()
        hil_document = convert_to_textract_format(hil_document)

        # Add empty tableType and headerColumnTypes to each page table
        # (this is where A2I annotation values will go)
        for page in hil_document['pages']:
            for table in page['tables']:
                table['headerColumnTypes'] = {}

        outputS3Uri.PutJSON(body = hil_document)

        Logger.info(f'{STAGE} Actor : Stopped Processing DocumentID = {document.DocumentID}')

    except Exception as e:
        
        print_exc()

        Logger.error(
            f'{STAGE} Actor : Errored Processing DocumentID = {document.DocumentID} > {str(e)}'
        )

        message.ActorGrade = FAIL
    
    message.MapUpdates.StageS3Uri = outputS3Uri
    message.FinalStamp            = GetCurrentStamp()

    Bus.PutMessage(stage = STAGE, message_body = message.to_json())

def convert_to_textract_format(doc):
    output_data = {
        "numPages": 1,
        "pages": [
            {
                "pageNumber": 1,
                "tables": []
            }
        ],
        "tableTypes":[],
        "metadata": {
            "sourceDocumentUrl": "s3://tdd-store-document-965637542341/extract/faktura.pdf"
        }
    }
    for key, val in doc.items():
        if isinstance(val, dict):
            form = create_form_table(key, val)
            output_data["pages"][0]["tables"].append(form)
            
        
        if isinstance(val, list):
            table = create_table(key, val)
            output_data["pages"][0]["tables"].append(table)
    
    for  table in output_data["pages"][0]["tables"]:
        output_data["tableTypes"].append({
            "name": table["tableType"],
            "columnTypes": table["columnTypes"]
        })

    return output_data

# Function to create a form table
def create_form_table(table_name, data):
    form_table = {
        "name": table_name,
        "tableType": "Form",
        "columnTypes": ["Key", "Value"],
        "rows": []
    }
    for key, value in data.items():
        row = [
            {
                "text": key,
                "confidence": 99.9,
                "boundingBox": {
                    "top": 0.0,
                    "left": 0.0,
                    "width": 0.1,
                    "height": 0.02
                },
                "tag": f"{key.lower()}-key"
            },
            {
                "text": value,
                "confidence": 99.9,
                "boundingBox": {
                    "top": 0.0,
                    "left": 0.2,
                    "width": 0.3,
                    "height": 0.02
                },
                "tag": f"{key.lower()}-value"
            }
        ]
        form_table["rows"].append(row)
    return form_table

def create_table(table_name, data):
    table = {
        "tableType": "Table",
        "name": table_name, 
        "columnTypes": [],
        "rows": []
    }


    for key, val in data[0].items():
        table["columnTypes"].append(key)

    for idx, item in enumerate(data):
        table_row = []
        for key, val in item.items():
            table_row.append({
                "text": val,
                "confidence": 99.9,
                "boundingBox": {
                    "top": 0.0,
                    "left": 0.0,
                    "width": 0.0,
                    "height": 0.0
                },
                "tag": f"row-{idx}-r-br"
            })
        
        table["rows"].append(table_row)

    return table


if  __name__ == '__main__':

    lambda_handler({'DocumentID': '001'}, None)
