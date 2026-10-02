# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""
SKLearn model handler for SageMaker inference
"""
import os
import json
import pickle
import joblib
import numpy as np
from typing import Any, Dict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ModelHandler:
    """Handle SKLearn model loading and inference"""

    def __init__(self, model_path: str):
        self.model_path = model_path
        self.model = None
        self._loaded = False

    def load_model(self):
        """Load the SKLearn model"""
        try:
            model_files = [f for f in os.listdir(self.model_path) if f.endswith('<%= modelFormat %>')]

            if not model_files:
                logger.warning("No SKLearn model files found in model directory")
                logger.warning("Server will start but /invocations will fail until a model is provided")
                logger.warning("Mount a model directory with: MODEL_DIR=/path/to/model ./do/run")
                return

            model_file = os.path.join(self.model_path, model_files[0])
            logger.info(f"Loading model from {model_file}")

            # Load with joblib first, fallback to pickle
            try:
                self.model = joblib.load(model_file)
            except:
                with open(model_file, 'rb') as f:
                    self.model = pickle.load(f)

            self._loaded = True
            logger.info("SKLearn model loaded successfully")

        except Exception as e:
            logger.error(f"Error loading model: {str(e)}")
            raise

    def is_loaded(self) -> bool:
        """Check if model is loaded"""
        return self._loaded and self.model is not None

    def preprocess(self, raw_data: Any) -> np.ndarray:
        """Preprocess input data for SKLearn model"""
        try:
            if isinstance(raw_data, dict):
                data = raw_data.get('instances', raw_data.get('data', raw_data))
            else:
                data = raw_data

            if isinstance(data, str):
                data = json.loads(data)

            return np.array(data)

        except Exception as e:
            logger.error(f"Error in preprocessing: {str(e)}")
            raise ValueError(f"Invalid input data format: {str(e)}")

    def postprocess(self, predictions: np.ndarray) -> Dict[str, Any]:
        """Postprocess SKLearn model predictions"""
        try:
            if hasattr(predictions, 'tolist'):
                predictions = predictions.tolist()

            return {'predictions': predictions}

        except Exception as e:
            logger.error(f"Error in postprocessing: {str(e)}")
            raise

    def predict(self, input_data: Any) -> Dict[str, Any]:
        """Run inference on input data"""
        if not self.is_loaded():
            raise RuntimeError("Model is not loaded")

        try:
            processed_input = self.preprocess(input_data)
            predictions = self.model.predict(processed_input)
            return self.postprocess(predictions)

        except Exception as e:
            logger.error(f"Error during inference: {str(e)}")
            raise
