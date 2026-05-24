```
    ┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
    │  Local Models    │         │  S3 Buckets*     │         │  HuggingFace Hub │
    │                  │         │                  │         │                  │
    │  • .pkl files    │         │  • Model         │         │  • Transformers  │
    │  • .joblib       │         │    artifacts     │         │  • LLMs          │
    │  • .h5           │         │  • Checkpoints   │         │  • Chat models   │
    └────────┬─────────┘         └────────┬─────────┘         └────────┬─────────┘
             │                            │                            │
             └────────────────────────────┼────────────────────────────┘
                                          │
                                          │
                                          ▼
    ┌───────────────────────────────────────┬───────────────────────────────────────┐
    │     PREDICTIVE ML                     │     GENERATIVE AI                     │
    │     (Traditional ML)                  │     (LLMs / Transformers)             │
    └───────────────────────────────────────┴───────────────────────────────────────┘
    
    ┌───────────────────────────────────────┐ ┌───────────────────────────────────┐
    │  Framework Selection                  │ │  Framework Selection              │
    │  ┌─────────────────────────────────┐  │ │  ┌─────────────────────────────┐  │
    │  │  • scikit-learn                 │  │ │  │  • Transformers             │  │
    │  │  • XGBoost                      │  │ │  └─────────────────────────────┘  │
    │  │  • TensorFlow                   │  │ │                                   │
    │  └─────────────────────────────────┘  │ │  Serving Framework (Combined)     │
    │                                       │ │  ┌─────────────────────────────┐  │
    │  Model Serving (Inference Logic)      │ │  │  • vLLM                     │  │
    │  ┌─────────────────────────────────┐  │ │  │  • SGLang                   │  │
    │  │  • model_handler.py             │  │ │  │  • TensorRT-LLM             │  │
    │  └─────────────────────────────────┘  │ │  │  • LMI                      │  │
    │                                       │ │  │  • DJL                      │  │
    │  Web Serving (HTTP Layer)             │ │  └─────────────────────────────┘  │
    │  ┌─────────────────────────────────┐  │ │                                   │
    │  │  • Flask / FastAPI              │  │ │  (Handles both model loading      │
    │  │  • /ping endpoint               │  │ │   and HTTP serving w/NGINX)       │
    │  │  • /invocations endpoint        │  │ │                                   │
    │  │  • Nginx reverse proxy          │  │ └───────────────────────────────────┘
    │  └─────────────────────────────────┘  │              |
    └───────────────────────────────────────┘              |
                    │                                      │
                    └──────────────────┬───────────────────┘
                                       ▼
                            ┌─────────────────────┐
                            │   Dockerfile        │
                            │   Generation        │
                            └──────────┬──────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
                    ▼                  ▼                  ▼
         ┌──────────────────┐ ┌──────────────┐ ┌──────────────────┐
         │  Base Image      │ │  Dependencies│ │  Application     │
         │                  │ │              │ │  Code            │
         │  • Python 3.x    │ │  • Framework │ │                  │
         │  • CUDA (GPU)    │ │    packages  │ │  • serve.py      │
         │  • Frameworks    │ │  • ML libs   │ │  • model_handler │
         └──────────────────┘ └──────────────┘ │  • nginx.conf    │
                                               └──────────────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │   Docker Build      |
                            |    (local/remote)   │
                            │                     │
                            │   docker build -t   │
                            │   my-model:latest   │
                            └──────────┬──────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │   Push to ECR       │
                            │                     │
                            │   AWS Container     │
                            │   Registry          │
                            └──────────┬──────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────────┐
                    │   SageMaker AI Endpoint (Running)      │
                    │                                     │
                    │   ┌─────────────────────────────┐   │
                    │   │  Container Instance         │   │
                    │   │                             │   │
                    │   │  • Model loaded in memory   │   │
                    │   │  • HTTP server listening    │   │
                    │   │  • Port 8080                │   │
                    │   │                             │   │
                    │   │  Endpoints:                 │   │
                    │   │  • GET  /ping               │   │
                    │   │  • POST /invocations        │   │
                    │   └─────────────────────────────┘   │
                    │                                     │
                    │   Instance Type:                    │
                    │   • CPU: ml.m5.xlarge               │
                    │   • GPU: ml.g5.xlarge               │
                    |   • Custom                          |
                    └─────────────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │   Client Applications               │
                    │                                     │
                    │   • REST API calls                  │
                    │   • Real-time inference             │
                    │   • Predictions returned            │
                    └─────────────────────────────────────┘
```