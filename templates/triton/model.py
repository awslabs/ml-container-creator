# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Triton Python Backend Model Implementation

This module implements the TritonPythonModel interface for serving
custom Python models via NVIDIA Triton Inference Server.

Backend: python
Model: <%= modelName || 'model' %>
"""

import json
import os

import numpy as np
import triton_python_backend_utils as pb_utils

<% if (modelFormat === 'pkl') { %>
import pickle
<% } else if (modelFormat === 'joblib') { %>
import joblib
<% } %>


class TritonPythonModel:
    """Triton Python backend model implementation.

    This class implements the required interface for Triton's Python backend:
    - initialize(): Called once when the model is loaded
    - execute(): Called for each inference request batch
    - finalize(): Called once when the model is unloaded
    """

    def initialize(self, args):
        """Initialize the model.

        Called once when the model is loaded by Triton. Use this method to
        load model artifacts and set up any required resources.

        Args:
            args: Dictionary containing model configuration:
                - model_config: JSON string of the model configuration
                - model_instance_kind: Device type (CPU/GPU)
                - model_instance_device_id: Device ID
                - model_repository: Path to the model repository
                - model_version: Model version being loaded
                - model_name: Name of the model
        """
        self.model_config = json.loads(args['model_config'])
        model_repository = args['model_repository']
        model_version = args['model_version']

        # Construct path to model artifact
        model_dir = os.path.join(model_repository, model_version)

<% if (modelFormat === 'pkl') { %>
        # Load pickle model
        model_path = os.path.join(model_dir, 'model.pkl')
        with open(model_path, 'rb') as f:
            self.model = pickle.load(f)
<% } else if (modelFormat === 'joblib') { %>
        # Load joblib model
        model_path = os.path.join(model_dir, 'model.joblib')
        self.model = joblib.load(model_path)
<% } else { %>
        # Custom model loading
        # TODO: Implement your model loading logic here
        # model_path = os.path.join(model_dir, 'your_model_file')
        self.model = None
<% } %>

        # Get output configuration from model config
        output_config = pb_utils.get_output_config_by_name(
            self.model_config, 'OUTPUT'
        )
        self.output_dtype = pb_utils.triton_string_to_numpy(
            output_config['data_type']
        )

    def execute(self, requests):
        """Handle inference requests.

        Called for each batch of inference requests. Processes input tensors
        and returns output tensors.

        Args:
            requests: List of pb_utils.InferenceRequest objects

        Returns:
            List of pb_utils.InferenceResponse objects
        """
        responses = []

        for request in requests:
            # Get input tensor
            input_tensor = pb_utils.get_input_tensor_by_name(request, 'INPUT')
            input_data = input_tensor.as_numpy()

<% if (modelFormat === 'pkl' || modelFormat === 'joblib') { %>
            # Run prediction
            predictions = self.model.predict(input_data)
            output_data = np.array(predictions, dtype=self.output_dtype)
<% } else { %>
            # Custom inference logic
            # TODO: Implement your inference logic here
            output_data = np.zeros(
                (input_data.shape[0], 1), dtype=self.output_dtype
            )
<% } %>

            # Create output tensor
            output_tensor = pb_utils.Tensor('OUTPUT', output_data)

            # Create inference response
            inference_response = pb_utils.InferenceResponse(
                output_tensors=[output_tensor]
            )
            responses.append(inference_response)

        return responses

    def finalize(self):
        """Clean up resources.

        Called once when the model is being unloaded. Use this method to
        release any resources held by the model.
        """
        self.model = None
