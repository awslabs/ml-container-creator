# Walkthrough: add your own `do/train` technique

This walkthrough takes a sample technique, drops it into a generated project, and uses
it end to end: see its knobs, set values, catch mistakes, change the knobs, and submit.
It takes about ten minutes and needs no AWS calls until the last step.

The sample is **`sft-neftune`**: LoRA supervised fine-tuning with NEFTune embedding
noise and a selectable learning-rate schedule. It ships with ml-container-creator in
`examples/train-plugins/sft-neftune/`. It follows the shipped `sft` recipe, so it runs
on the same training image.

For the full reference (every manifest key, tiers, precedence, validation rules), see
[Authoring do/train Techniques](train-plugin-authoring.md).

---

## 1. What's in the sample

```
sft-neftune/
├── train.py                # the training script (required)
├── manifest.json           # describes the knobs: type, bounds, tier, help text
├── defaults.yaml           # the knobs' default values
└── accelerate_config.yaml  # distributed launcher config (copied from the sft recipe)
```

Two files, two jobs:

- **`manifest.json` describes knobs.** For example, `lr_scheduler_type` is a string
  limited to four values, shown only with `--advanced`:

  ```json
  "lr_scheduler_type": {
    "type": "string",
    "required": false,
    "enum": ["linear", "cosine", "constant", "constant_with_warmup"],
    "tier": "advanced",
    "display_name": "LR scheduler",
    "description": "learning-rate schedule"
  }
  ```

- **`defaults.yaml` holds values.** `lr_scheduler_type: cosine`,
  `neftune_noise_alpha: 5`, and so on.

The sample uses each kind of knob the manifest supports:

| Knob | Shows | Tier |
|---|---|---|
| `learning_rate`, `epochs`, `batch_size`, `max_seq_length` | numbers with a lower bound | primary |
| `lora_r` | a dropdown (`enum`: 8, 16, 32, 64, 128) | primary |
| `neftune_noise_alpha` | a number ≥ 0, with a `hint` | primary |
| `dataset_text_field` | free text | primary |
| `lr_scheduler_type` | a dropdown | advanced |
| `warmup_ratio`, `lora_dropout` | a number between 0 and 1 | advanced |
| `packing` | a boolean | advanced |
| `seed`, `model_id` | never prompted, settable with `--set` | tertiary |

`train.py` reads exactly the knobs the manifest declares, in one function
(`default_hyperparameters()`). Keep those two lists in step when you change the sample.

## 2. Copy it into your project

From your generated project's root:

```bash
SAMPLES="$(npm root -g)/@aws/ml-container-creator/examples/train-plugins"
cp -r "$SAMPLES/sft-neftune" do/training/
```

If you installed ml-container-creator somewhere other than the global npm root, the
sample is under `examples/train-plugins/` in the package or the GitHub repo.

`do/train` discovers techniques by directory, so it shows up right away:

```bash
./do/train --help
```

```
Available techniques:
  custom, dpo, grpo, sft-neftune, sft
```

The copied `manifest.json` points `"$schema"` at `../manifest.schema.json`, which every
project already has. Open the manifest in VS Code and you get validation and
autocomplete as you edit it.

## 3. Point the job at it

Edit `do/training/config.yaml`:

```yaml
technique: "sft-neftune"
script: "do/training/sft-neftune/train.py"
dataset: "s3://my-bucket/datasets/alpaca/"       # a .jsonl/.parquet/.csv with a "text" column
output_path: "s3://my-bucket/train-out/"
hyperparameters:
  epochs: "2"
```

Leave the image, instance type, and the rest as generated. `--technique sft-neftune` on
the command line also works if you'd rather not edit `technique:`.

## 4. See what the job will get

`--dry-run` resolves everything and writes the request without submitting:

```bash
./do/train --dry-run
```

```
⚙  Hyperparameters this job will use (sft-neftune, manifest.json):
   batch_size                   4                 (defaults.yaml)
   dataset_text_field           text              (defaults.yaml)
   epochs                       2                 (config.yaml)
   gradient_accumulation_steps  4                 (defaults.yaml)
   learning_rate                2e-4              (defaults.yaml)
   lora_alpha                   32                (defaults.yaml)
   lora_dropout                 0.05              (defaults.yaml)
   lora_r                       16                (defaults.yaml)
   lr_scheduler_type            cosine            (defaults.yaml)
   max_seq_length               2048              (defaults.yaml)
   neftune_noise_alpha          5                 (defaults.yaml)
   packing                      False             (defaults.yaml)
   seed                         42                (defaults.yaml)
   warmup_ratio                 0.03              (defaults.yaml)
✅ Request written to /tmp/train-request-<project>-train-<timestamp>.json
```

The right-hand column says where each value came from. `epochs` is `2` because
`config.yaml` overrides `defaults.yaml`. Values reach `train.py` as the strings you
wrote, so `2e-4` stays `2e-4`.

## 5. Override a value

```bash
./do/train --set neftune_noise_alpha=10 --set lr_scheduler_type=linear --dry-run
```

```
   lr_scheduler_type            linear            (flag)
   neftune_noise_alpha          10                (flag)
```

`--set` beats `config.yaml`, which beats `defaults.yaml`. The legacy flags still work:
`--learning-rate 1e-4` is the same as `--set learning_rate=1e-4`.

## 6. Let it catch your mistakes

Each of these stops before anything is submitted, with exit code 1.

A typo in a knob name:

```bash
./do/train --set neftune_alpha=10 --dry-run
```

```
❌ Hyperparameter validation failed for technique 'sft-neftune':
   • unknown knob 'neftune_alpha' for technique 'sft-neftune' — did you mean 'neftune_noise_alpha'? Declared: batch_size, dataset_text_field, epochs, ... (use --allow-unknown to pass it to train.py anyway)
```

A value outside its `enum`:

```bash
./do/train --set lr_scheduler_type=cosine_restarts --dry-run
```

```
   • knob 'lr_scheduler_type' must be one of ['linear', 'cosine', 'constant', 'constant_with_warmup']; got 'cosine_restarts'
```

The same check applies through a legacy flag:

```bash
./do/train --lora-r 24 --dry-run
```

```
   • knob 'lora_r' must be one of [8, 16, 32, 64, 128]; got 24
```

Without the manifest, all three would have reached the training job. `train.py` would
have ignored the typo and crashed on the other two partway through a paid job.

If your `train.py` reads a key you haven't declared yet, `--allow-unknown` passes it
through with a notice. Declaring the knob is the better long-term fix.

## 7. Answer questions instead of typing flags

```bash
./do/train -i              # job questions, then the primary knobs
./do/train -i --advanced   # ...plus the advanced knobs (scheduler, warmup, packing, ...)
```

The job questions come first (technique, model, dataset, instance). Then each knob is
asked with its `display_name`, its `description` as help, and its current value
pre-filled. `lora_r` and `lr_scheduler_type` are dropdowns, because they have an `enum`.
Your answers are saved to the `hyperparameters:` block of `config.yaml`, so the next run
reuses them. Tertiary knobs (`seed`, `model_id`) are never asked; set them with `--set`.

## 8. Make it yours: add a knob

Say you want `max_grad_norm` (gradient clipping). Three edits:

1. **Declare it** in `manifest.json`, under `hyperparameters`:

   ```json
   "max_grad_norm": {
     "type": "number",
     "required": false,
     "min": 0,
     "tier": "advanced",
     "display_name": "Max gradient norm",
     "description": "clip gradients to this norm; 0 turns clipping off"
   }
   ```

2. **Give it a value** in `defaults.yaml`:

   ```yaml
   max_grad_norm: 1.0
   ```

3. **Read it** in `train.py`. Add it to `default_hyperparameters()`, then pass it on:

   ```python
   "max_grad_norm": 1.0,           # in default_hyperparameters()
   ...
   max_grad_norm=hp["max_grad_norm"],   # in TrainingArguments(...)
   ```

Run `./do/train --dry-run` again. `max_grad_norm` now appears in the summary, and
`./do/train -i --advanced` asks for it.

## 9. See what a broken manifest looks like

`do/train` validates the manifest before doing anything else and reports every problem
at once, with exit code 2. For example, after two bad edits (a `min` above the `max`,
and `choices` written instead of `enum`):

```
❌ Invalid training manifest: do/training/sft-neftune/manifest.json
   • hyperparameters.warmup_ratio: 'min' (2) is greater than 'max' (1)
   • hyperparameters.seed: unknown key 'choices' (did you mean 'enum'?)
   → Fix the manifest, or delete it to fall back to defaults.yaml + flags.
```

You never get a Python traceback from a manifest mistake. Deleting the manifest is
always a way out: the technique keeps working without validation, like the shipped
`custom` technique.

## 10. Submit

When the dry run looks right:

```bash
./do/train                # submit with config.yaml's technique
./do/train --status       # follow the job
```

The job writes a LoRA adapter (`adapter_model.safetensors` + `adapter_config.json`) to
your output path, the same as the shipped `sft` recipe.

## Naming your own techniques

Use lowercase letters, digits, `_`, and `-`, starting with a letter or digit
(`my-technique`, `sft_v2`). The directory name and the manifest's `technique` field must
match. Hyphens are fine: values that `do/train` records in `do/config` use the
underscore form (`TRAIN_ADAPTER_PATH_MY_TECHNIQUE`).

## Next steps

- [Authoring do/train Techniques](train-plugin-authoring.md): every manifest key,
  precedence, validation rules, and upgrading older projects.
- [Custom Training](custom-training.md): datasets, instances, spot, and the job
  lifecycle.
