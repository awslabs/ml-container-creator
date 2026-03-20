# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import numpy as np
<% if (architecture === 'triton') { %>
<% if (backend === 'fil' && (modelFormat === 'xgboost_json' || modelFormat === 'xgboost_ubj')) { %>
import xgboost as xgb
<% } else if (backend === 'fil' && modelFormat === 'lightgbm_txt') { %>
import lightgbm as lgb
<% } else if (backend === 'onnxruntime') { %>
import onnxruntime as ort
<% } else if (backend === 'tensorflow') { %>
import tensorflow as tf
<% } else if (backend === 'python' && modelFormat === 'pkl') { %>
import pickle
<% } else if (backend === 'python' && modelFormat === 'joblib') { %>
import joblib
<% } %>
<% } else { %>
<% if (framework === 'sklearn') { %>
<% if (modelFormat === 'joblib') { %>import joblib
<% } else if (modelFormat === 'pkl') { %>import pickle
<% } %>
<% } else if (framework === 'xgboost') { %>import xgboost as xgb
<% } else if (framework === 'tensorflow') { %>import tensorflow as tf
<% } %>
<% } %>

# Load the trained model
<% if (architecture === 'triton') { %>
<% if (backend === 'fil' && modelFormat === 'xgboost_json') { %>
model = xgb.Booster()
model.load_model('./abalone_model.json')
<% } else if (backend === 'fil' && modelFormat === 'xgboost_ubj') { %>
model = xgb.Booster()
model.load_model('./abalone_model.ubj')
<% } else if (backend === 'fil' && modelFormat === 'lightgbm_txt') { %>
model = lgb.Booster(model_file='./abalone_model.txt')
<% } else if (backend === 'onnxruntime') { %>
session = ort.InferenceSession('./abalone_model.onnx')
<% } else if (backend === 'tensorflow') { %>
model = tf.saved_model.load('./abalone_model.savedmodel')
<% } else if (backend === 'python' && modelFormat === 'pkl') { %>
with open('./abalone_model.pkl', 'rb') as f:
    model = pickle.load(f)
<% } else if (backend === 'python' && modelFormat === 'joblib') { %>
model = joblib.load('./abalone_model.joblib')
<% } %>
<% } else { %>
<% if (framework === 'sklearn') { %>
<% if (modelFormat === 'joblib') { %>model = joblib.load('./abalone_model.joblib')
<% } else if (modelFormat === 'pkl') { -%>
with open('./abalone_model.pkl', 'rb') as f:
    model = pickle.load(f)
<% } %>
<% } else if (framework === 'xgboost') { %>model = xgb.Booster()
<% if (modelFormat === 'json') { %>model.load_model('./abalone_model.json')
<% } else if (modelFormat === 'model') { %>model.load_model('./abalone_model.model')
<% } else if (modelFormat === 'ubj') { %>model.load_model('./abalone_model.ubj')
<% } %>
<% } else if (framework === 'tensorflow') { %>
<% if (modelFormat === 'keras') { %>model = tf.keras.models.load_model('./abalone_model.keras')
<% } else if (modelFormat === 'h5') { %>model = tf.keras.models.load_model('./abalone_model.h5')
<% } else if (modelFormat === 'SavedModel') { %>model = tf.saved_model.load('./abalone_model')
model = model.signatures['serving_default']
<% } %>
<% } %>
<% } %>

# Create synthetic input array for abalone prediction
# Features: [Sex, Length, Diameter, Height, Whole_weight, Shucked_weight, Viscera_weight, Shell_weight]
# Sex: 0=M, 1=F, 2=I (Infant)
synthetic_input = np.array([[
    1,      # Sex: Female
    0.455,  # Length
    0.365,  # Diameter
    0.095,  # Height
    0.514,  # Whole weight
    0.2245, # Shucked weight
    0.101,  # Viscera weight
    0.15    # Shell weight
]])

# Make prediction
<% if (architecture === 'triton') { %>
<% if (backend === 'fil' && (modelFormat === 'xgboost_json' || modelFormat === 'xgboost_ubj')) { %>
feature_names = ['Sex', 'Length', 'Diameter', 'Height', 'Whole_weight', 'Shucked_weight', 'Viscera_weight', 'Shell_weight']
dtest = xgb.DMatrix(synthetic_input, feature_names=feature_names)
prediction = model.predict(dtest)
print(f"Predicted rings: {prediction[0]:.1f}")
<% } else if (backend === 'fil' && modelFormat === 'lightgbm_txt') { %>
prediction = model.predict(synthetic_input)
print(f"Predicted rings: {prediction[0]:.1f}")
<% } else if (backend === 'onnxruntime') { %>
input_name = session.get_inputs()[0].name
prediction = session.run(None, {input_name: synthetic_input.astype(np.float32)})
print(f"Predicted rings: {prediction[0][0]:.1f}")
<% } else if (backend === 'tensorflow') { %>
infer = model.signatures['serving_default']
input_tensor = tf.constant(synthetic_input, dtype=tf.float32)
prediction = infer(input_tensor)
output_key = list(prediction.keys())[0]
result = prediction[output_key].numpy()
print(f"Predicted rings: {result[0][0]:.1f}")
<% } else if (backend === 'python') { %>
prediction = model.predict(synthetic_input)
print(f"Predicted rings: {prediction[0]:.1f}")
<% } %>
<% } else { %>
<% if (framework === 'sklearn') { %>prediction = model.predict(synthetic_input)
print(f"Predicted rings: {prediction[0]:.1f}")
<% } else if (framework === 'xgboost') { %>feature_names = ['Sex', 'Length', 'Diameter', 'Height', 'Whole_weight', 'Shucked_weight', 'Viscera_weight', 'Shell_weight']
dtest = xgb.DMatrix(synthetic_input, feature_names=feature_names)
prediction = model.predict(dtest)
print(f"Predicted rings: {prediction[0]:.1f}")
<% } else if (framework === 'tensorflow') { %>
<% if (modelFormat === 'SavedModel') { %>prediction = model(synthetic_input)
output_key = list(prediction.keys())[0]
result = prediction[output_key].numpy()
print(f"Prediction: {result[0][0]:.2f} rings")<% } else { %>prediction = model.predict(synthetic_input)
print(f"Prediction: {prediction[0][0]:.2f} rings")<% } %>
<% } %>
<% } %>
