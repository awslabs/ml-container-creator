#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""
SageMaker inference server script
"""
import os
import logging
<% if (modelServer === 'flask') { %>
from flask import Flask, request, jsonify
<% } else if (modelServer === 'fastapi') { %>
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
<% } else if (modelServer === 'sglang') { %>
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.responses import JSONResponse
import asyncio
from sglang import Runtime
<% } %>
from model_handler import ModelHandler

# Configure logging
logging.basicConfig(level=logging.INFO,
                   format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)
model_handler = None

<% if (modelServer === 'flask') { %>
app = Flask(__name__)

def create_app():
    app = Flask(__name__)

    @app.route('/ping', methods=['GET'])
    def ping():
        """Health check endpoint"""
        if model_handler and model_handler.is_loaded():
            return jsonify({'status': 'healthy'})
        return jsonify({'status': 'model not loaded'}), 503

    @app.route('/invocations', methods=['POST'])
    def invocations():
        """Main inference endpoint"""
        if not model_handler or not model_handler.is_loaded():
            return jsonify({'error': 'Model not loaded'}), 503

        try:
            data = request.get_json() if request.is_json else request.data
            result = model_handler.predict(data)
            return jsonify(result)
        except ValueError as e:
            return jsonify({'error': f'Invalid input: {str(e)}'}), 400
        except Exception as e:
            logger.exception("Error during inference")
            return jsonify({'error': str(e)}), 500

    return app

def load_model_for_worker():
    """Load the model when the server starts"""
    global model_handler
    model_path = "/opt/ml/model"
    logger.info(f"Loading model from {model_path}")
    model_handler = ModelHandler(model_path)
    model_handler.load_model()
    logger.info("Model loaded successfully")
<% } else if (modelServer === 'fastapi') { %>
app = FastAPI()

@app.on_event("startup")
async def startup_event():
    """Load the model when the server starts"""
    global model_handler
    model_path = "/opt/ml/model"
    logger.info(f"Loading model from {model_path}")
    model_handler = ModelHandler(model_path)
    model_handler.load_model()
    logger.info("Model loaded successfully")

@app.get('/ping')
async def ping():
    """Health check endpoint"""
    if model_handler and model_handler.is_loaded():
        return {'status': 'healthy'}
    raise HTTPException(status_code=503, detail={'status': 'model not loaded'})

@app.post('/invocations')
async def invocations(request: Request):
    """Main inference endpoint"""
    if not model_handler or not model_handler.is_loaded():
        raise HTTPException(status_code=503, detail={'error': 'Model not loaded'})

    try:
        content_type = request.headers.get('content-type', '')
        if 'application/json' in content_type:
            data = await request.json()
        else:
            data = await request.body()
        
        result = model_handler.predict(data)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail={'error': f'Invalid input: {str(e)}'})
    except Exception as e:
        logger.exception("Error during inference")
        raise HTTPException(status_code=500, detail={'error': str(e)})

<% } else if (modelServer === 'sglang') { %>
app = FastAPI()
sglang_runtime = None

@app.on_event("startup")
async def startup_event():
    """Initialize SGLang runtime when the server starts"""
    global sglang_runtime
    model_id = "<%= model %>"
    logger.info(f"Initializing SGLang runtime with model: {model_id}")

    sglang_runtime = Runtime(
        model_path=model_id,
        tokenizer_path=model_id,
        device="cuda",
        mem_fraction_static=0.8
    )
    logger.info("SGLang runtime initialized successfully")

@app.get('/ping')
async def ping():
    """Health check endpoint"""
    if sglang_runtime:
        return {'status': 'healthy'}
    raise HTTPException(status_code=503, detail={'status': 'runtime not loaded'})

@app.post('/invocations')
async def invocations(request: Request):
    """Main inference endpoint"""
    if not sglang_runtime:
        raise HTTPException(status_code=503, detail={'error': 'Runtime not loaded'})

    try:
        content_type = request.headers.get('content-type', '')
        if 'application/json' in content_type:
            data = await request.json()
        else:
            data = await request.body()

        # Extract prompts from SageMaker format
        if isinstance(data, dict):
            prompts = data.get('instances', data.get('inputs', [data]))
        else:
            prompts = [data]

        # Generate responses
        outputs = sglang_runtime.generate(prompts)
        return {'predictions': outputs}

    except ValueError as e:
        raise HTTPException(status_code=400, detail={'error': f'Invalid input: {str(e)}'})
    except Exception as e:
        logger.exception("Error during inference")
        raise HTTPException(status_code=500, detail={'error': str(e)})
<% } %>

if __name__ == '__main__':
<% if (modelServer === 'flask') { %>
    app = create_app()
    load_model_for_worker()  # Load model for development server
    port = int(os.environ.get("SAGEMAKER_BIND_TO_PORT", 8080))
    app.run(host='0.0.0.0', port=port, debug=False)
<% } else if (modelServer === 'fastapi' || modelServer === 'sglang') { %>
    import uvicorn
    port = int(os.environ.get("SAGEMAKER_BIND_TO_PORT", 8080))
    uvicorn.run(app, host='0.0.0.0', port=port)
<% } %>