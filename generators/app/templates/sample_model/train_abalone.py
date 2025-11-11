# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import numpy as np
from ucimlrepo import fetch_ucirepo
<% if (framework === 'sklearn') { %>from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
<% if (modelFormat === 'joblib') { %>import joblib<% } else if (modelFormat === 'pkl') { %>import pickle<% } %>
<% } else if (framework === 'xgboost' || framework === 'tensorflow') { %>
<% if (framework === 'xgboost') { %>import xgboost as xgb<% } %>
<% if (framework === 'tensorflow') { %>import tensorflow as tf<% } %>

def train_test_split(X, y, test_size=0.2, random_state=None):
    if random_state is not None:
        np.random.seed(random_state)

    n_samples = len(X)
    n_test = int(n_samples * test_size)

    indices = np.random.permutation(n_samples)
    test_indices = indices[:n_test]
    train_indices = indices[n_test:]

    return X.iloc[train_indices], X.iloc[test_indices], y[train_indices], y[test_indices]
<% } %>

abalone = fetch_ucirepo(id=1)

X = abalone.data.features.copy()
y = abalone.data.targets.values.ravel()

# Encode Sex column (M=0, F=1, I=2)
sex_map = {'M': 0, 'F': 1, 'I': 2}
X['Sex'] = X['Sex'].map(sex_map)

# Split data
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

<% if (framework === 'sklearn') { %># Train sklearn model
model = RandomForestRegressor(n_estimators=100, random_state=42)
model.fit(X_train, y_train)

print(f"Model trained and saved. Test score: {model.score(X_test, y_test):.3f}")
<% } else if (framework === 'xgboost') { %># Train XGBoost model
model = xgb.XGBRegressor(n_estimators=100, random_state=42)
model.fit(X_train, y_train)

# Evaluate
test_score = model.score(X_test, y_test)
print(f"Model trained. Test score: {test_score:.3f}")
<% } else if (framework === 'tensorflow') { %># Train TensorFlow model
# Create TensorFlow model
model = tf.keras.Sequential([
    tf.keras.layers.Dense(64, activation='relu', input_shape=(X_train.shape[1],)),
    tf.keras.layers.Dense(32, activation='relu'),
    tf.keras.layers.Dense(1)
])

model.compile(optimizer='adam', loss='mse', metrics=['mae'])

# Train model
model.fit(X_train, y_train, epochs=50, batch_size=32, validation_split=0.2, verbose=0)

# Calculate test score
test_loss, test_mae = model.evaluate(X_test, y_test, verbose=0)
print(f"Model trained and saved. Test MAE: {test_mae:.3f}")
<% } %>

# Save model
<% if (modelFormat === 'joblib') { %>joblib.dump(model, './abalone_model.joblib')<% }
else if (modelFormat === 'pkl') { %>with open('./abalone_model.pkl', 'wb') as f: pickle.dump(model, f)<% }
else if (modelFormat === 'json') { %>model.save_model('./abalone_model.json')<% }
else if (modelFormat === 'model') { %>model.save_model('./abalone_model.model')<% }
else if (modelFormat === 'ubj') { %>model.save_model('./abalone_model.ubj')<% }
else if (modelFormat === 'h5') { %>model.save('./abalone_model.h5')<% }
else if (modelFormat === 'keras') { %>model.save('./abalone_model.keras')<% }
else if (modelFormat === 'SavedModel') {%>model.export('./abalone_model')<% } %>

print("Model saved.")
