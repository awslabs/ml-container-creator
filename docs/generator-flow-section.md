## Generator Flow

The ML Container Creator follows a structured flow to collect configuration and generate deployment assets. Here's what happens when you run the generator:

### Interactive Mode

```bash
yo ml-container-creator
```

**Step 1: Project Configuration**
```
? Project name: my-sklearn-model
? Output directory: ./my-sklearn-model
```

**Step 2: Framework Selection**
```
? Which ML framework are you using?
  ❯ scikit-learn
    XGBoost
    TensorFlow
    Transformers
```

**Step 3: Model Configuration**
```
? Model format?
  ❯ pkl
    joblib

? Which model server?
  ❯ Flask
    FastAPI
```

**Step 4: Optional Modules**
```
? Include sample model code? (Y/n) Y
? Include test suite? (Y/n) Y
? Which test types?
  ❯ ◉ Local model CLI
    ◉ Local model server
    ◯ Hosted model endpoint
```

**Step 5: Infrastructure Configuration**
```
? Deployment target?
  ❯ SageMaker
    CodeBuild

? Instance type?
  ❯ CPU-optimized (ml.m5.xlarge)
    GPU-enabled (ml.g5.xlarge)
    Custom

? AWS Region? us-east-1
```

**Step 6: Generation**
```
✨ Generating project...
   create Dockerfile
   create requirements.txt
   create nginx.conf
   create code/model_handler.py
   create code/serve.py
   create deploy/build_and_push.sh
   create deploy/deploy.sh
   create sample_model/train_abalone.py
   create test/test_model_handler.py

🤖 Training sample model...
✅ Sample model training completed successfully!

✨ Done! Your ML container project is ready.
```

### Non-Interactive Mode (CLI)

For automation or CI/CD pipelines, skip prompts entirely:

```bash
yo ml-container-creator \
  --skip-prompts \
  --project-name="my-sklearn-model" \
  --framework="sklearn" \
  --model-server="flask" \
  --model-format="pkl" \
  --instance-type="cpu-optimized" \
  --deploy-target="sagemaker" \
  --include-sample=true \
  --include-testing=true \
  --region="us-east-1"
```

**Output:**
```
🚀 Skipping prompts - using configuration from CLI options

📦 Generating project...
✅ Project generated successfully!
```

### Configuration Sources

The generator merges configuration from multiple sources in this precedence order:

1. **CLI Options** (highest priority)
   ```bash
   --framework=sklearn --model-server=flask
   ```

2. **Environment Variables**
   ```bash
   export FRAMEWORK=sklearn
   export MODEL_SERVER=flask
   ```

3. **Config File** (`--config` flag)
   ```bash
   yo ml-container-creator --config=production.json
   ```

4. **Default Config File** (`config/mcp.json`)
   ```json
   {
     "framework": "sklearn",
     "modelServer": "flask"
   }
   ```

5. **Package.json Section**
   ```json
   {
     "ml-container-creator": {
       "framework": "sklearn",
       "modelServer": "flask"
     }
   }
   ```

6. **Interactive Prompts** (lowest priority)

### Example: Transformers Model

For generative AI models, the flow differs slightly:

```bash
yo ml-container-creator
```

```
? Which ML framework are you using?
  ❯ Transformers

? Model name (HuggingFace Hub ID): meta-llama/Llama-2-7b-chat-hf

? Which model server?
  ❯ vLLM
    SGLang
    TensorRT-LLM
    LMI
    DJL

? HuggingFace token (or $HF_TOKEN): $HF_TOKEN

? Instance type?
  ❯ GPU-enabled (ml.g5.xlarge)
    GPU-enabled (ml.g5.12xlarge)
    Custom
```

**Key Differences:**
- No model format selection (uses HuggingFace Hub)
- Requires HuggingFace token for private/gated models
- GPU instances required (CPU not available)
- No sample model generation (uses existing HF model)

### Generated Project Structure

After generation, you'll have a complete project:

```
my-sklearn-model/
├── Dockerfile                    # Container definition
├── requirements.txt              # Python dependencies
├── nginx.conf                    # Reverse proxy config
│
├── code/
│   ├── model_handler.py          # Model loading & inference
│   ├── serve.py                  # Flask/FastAPI server
│   └── flask/                    # Flask-specific code
│
├── deploy/
│   ├── build_and_push.sh         # Build & push to ECR
│   └── deploy.sh                 # Deploy to SageMaker
│
├── sample_model/
│   ├── train_abalone.py          # Training script
│   ├── abalone.csv               # Sample data
│   └── model.pkl                 # Trained model
│
└── test/
    ├── test_model_handler.py     # Unit tests
    ├── test_local_server.py      # Integration tests
    └── test_hosted_endpoint.py   # E2E tests
```

### Next Steps

After generation:

1. **Review generated files** - Customize for your needs
2. **Add your model** - Replace sample model with yours
3. **Build container** - `./deploy/build_and_push.sh`
4. **Deploy to SageMaker** - `./deploy/deploy.sh`
5. **Test endpoint** - Run test suite

See [Getting Started](getting-started.md) for detailed deployment instructions.
