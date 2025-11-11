# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
<% if (framework === 'sklearn') { %>
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
                raise FileNotFoundError("No SKLearn model files found in model directory")
            
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
<% } else if (framework === 'xgboost') { %>
"""
XGBoost model handler for SageMaker inference
"""
import os
import json
import xgboost as xgb
import numpy as np
from typing import Any, Dict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ModelHandler:
    """Handle XGBoost model loading and inference"""
    
    def __init__(self, model_path: str):
        self.model_path = model_path
        self.model = None
        self._loaded = False
        
    def load_model(self):
        """Load the XGBoost model"""
        try:
            model_files = [f for f in os.listdir(self.model_path) if f.endswith('<%= modelFormat %>')]
            
            if not model_files:
                raise FileNotFoundError("No XGBoost model files found in model directory")
            
            model_file = os.path.join(self.model_path, model_files[0])
            logger.info(f"Loading model from {model_file}")
            
            self.model = xgb.Booster()
            self.model.load_model(model_file)
            
            self._loaded = True
            logger.info("XGBoost model loaded successfully")
            
        except Exception as e:
            logger.error(f"Error loading model: {str(e)}")
            raise
    
    def is_loaded(self) -> bool:
        """Check if model is loaded"""
        return self._loaded and self.model is not None
    
    def preprocess(self, raw_data: Any) -> xgb.DMatrix:
        """Preprocess input data for XGBoost model"""
        try:
            if isinstance(raw_data, dict):
                data = raw_data.get('instances', raw_data.get('data', raw_data))
            else:
                data = raw_data
            
            if isinstance(data, str):
                data = json.loads(data)
            
            return xgb.DMatrix(np.array(data))
            
        except Exception as e:
            logger.error(f"Error in preprocessing: {str(e)}")
            raise ValueError(f"Invalid input data format: {str(e)}")
    
    def postprocess(self, predictions: np.ndarray) -> Dict[str, Any]:
        """Postprocess XGBoost model predictions"""
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
<% } else if (framework === 'tensorflow') { %>
"""
TensorFlow model handler for SageMaker inference
"""
import os
import json
import tensorflow as tf
import numpy as np
from typing import Any, Dict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ModelHandler:
    """Handle TensorFlow model loading and inference"""

    def __init__(self, model_path: str):
        self.model_path = model_path
        self.model = None
        self._loaded = False

    def load_model(self):
        """Load the TensorFlow model"""
        try:
            logger.info(f"Loading model from {self.model_path}")

            model_files = [f for f in os.listdir(self.model_path) if f.endswith(('.keras', '.h5'))]

            if not model_files:
                try:
                    self.model = tf.saved_model.load(self.model_path)
                    self.model = self.model.signatures['serving_default']
                except:
                    raise FileNotFoundError("No Tensorflow model files found in model directory")
            else:
                model_file = os.path.join(self.model_path, model_files[0])
                logger.info(f"Loading model from {model_file}")
                self.model = tf.keras.models.load_model(model_file, compile=False)

            self._loaded = True
            logger.info("TensorFlow model loaded successfully")

        except Exception as e:
            logger.error(f"Error loading model: {str(e)}")
            raise

    def is_loaded(self) -> bool:
        """Check if model is loaded"""
        return self._loaded and self.model is not None

    def preprocess(self, raw_data: Any) -> np.ndarray:
        """Preprocess input data for TensorFlow model"""
        try:
            if isinstance(raw_data, dict):
                data = raw_data.get('instances', raw_data.get('data', raw_data))
            else:
                data = raw_data

            if isinstance(data, str):
                data = json.loads(data)

            return np.array(data, dtype=np.float32)

        except Exception as e:
            logger.error(f"Error in preprocessing: {str(e)}")
            raise ValueError(f"Invalid input data format: {str(e)}")

    def postprocess(self, predictions: np.ndarray) -> Dict[str, Any]:
        """Postprocess TensorFlow model predictions"""
        try:
            if hasattr(predictions, 'numpy'):
                predictions = predictions.numpy()

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

            # Handle different model types
            if hasattr(self.model, 'predict'):
                # Keras model
                predictions = self.model.predict(processed_input)
            else:
                # SavedModel signature
                input_tensor = tf.constant(processed_input)
                result = self.model(input_tensor)
                predictions = list(result.values())[0]

            return self.postprocess(predictions)

        except Exception as e:
            logger.error(f"Error during inference: {str(e)}")
            raise
<% } else if (framework === 'transformers' && modelServer === 'sglang') { %>
"""
SGLang model handler for SageMaker inference
"""
import os
import json
from typing import Any, Dict, List
import logging
from sglang import Runtime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ModelHandler:
    """Handle SGLang model loading and inference"""

    def __init__(self, model_path: str):
        self.model_path = model_path
        self.runtime = None
        self._loaded = False

    def load_model(self):
        """Initialize SGLang runtime"""
        try:
            model_id = '<%= model %>'
            logger.info(f"Loading SGLang model: {model_id}")

            self.runtime = Runtime(
                model_path=model_id,
                tokenizer_path=model_id,
                device="cuda",
                mem_fraction_static=0.8
            )

            self._loaded = True
            logger.info("SGLang model loaded successfully")

        except Exception as e:
            logger.error(f"Error loading model: {str(e)}")
            raise

    def is_loaded(self) -> bool:
        """Check if model is loaded"""
        return self._loaded and self.runtime is not None

    def preprocess(self, raw_data: Any) -> List[str]:
        """Preprocess input data for SGLang model"""
        try:
            if isinstance(raw_data, dict):
                data = raw_data.get('instances', raw_data.get('inputs', raw_data))
            else:
                data = raw_data

            if isinstance(data, str):
                return [data]
            elif isinstance(data, list):
                return data
            else:
                raise ValueError("Input must be string or list of strings")

        except Exception as e:
            logger.error(f"Error in preprocessing: {str(e)}")
            raise ValueError(f"Invalid input data format: {str(e)}")

    def postprocess(self, outputs: List[str]) -> Dict[str, Any]:
        """Postprocess SGLang model outputs"""
        try:
            return {'predictions': outputs}

        except Exception as e:
            logger.error(f"Error in postprocessing: {str(e)}")
            raise

    def predict(self, input_data: Any) -> Dict[str, Any]:
        """Run inference on input data"""
        if not self.is_loaded():
            raise RuntimeError("Model is not loaded")

        try:
            prompts = self.preprocess(input_data)
            outputs = self.runtime.generate(prompts)
            return self.postprocess(outputs)

        except Exception as e:
            logger.error(f"Error during inference: {str(e)}")
            raise
<% } %>
