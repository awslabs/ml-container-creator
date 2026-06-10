/**
 * MCC Interactive Command Generator
 * Generates full deployment scripts with multi-IC and adapter support.
 */
(function () {
    'use strict';

    // State
    let catalogs = {};
    let state = {
        projectName: 'my-project',
        model: '',
        deploymentConfig: 'transformers-vllm',
        serverVersion: '',
        instanceType: '',
        deploymentTarget: 'managed-inference',
        features: { lora: false, benchmark: false, secrets: false },
        lora: { maxLoras: 30, maxLoraRank: 64 },
        benchmark: { concurrency: 10, inputTokens: 550, outputTokens: 150, streaming: true },
        server: { tp: 1, maxModelLen: 4096, gpuMemUtil: 0.9, maxNumSeqs: 256, prefixCaching: true },
        infra: { startupTimeout: 900, gpuCount: '', copyCount: 1, minMemory: 1024 },
        envVars: [],
        additionalICs: [],
        adapters: []
    };

    const DEPLOYMENT_CONFIGS = [
        { value: 'transformers-vllm', label: 'Transformers - vLLM' },
        { value: 'transformers-sglang', label: 'Transformers - SGLang' },
        { value: 'transformers-tensorrt-llm', label: 'Transformers - TensorRT-LLM' },
        { value: 'transformers-lmi', label: 'Transformers - LMI' },
        { value: 'transformers-djl', label: 'Transformers - DJL' },
        { value: 'diffusors-vllm-omni', label: 'Diffusors - vLLM Omni' }
    ];

    const DEPLOYMENT_TARGETS = [
        { value: 'managed-inference', label: 'Managed Inference (Real-Time)' },
        { value: 'async-inference', label: 'Async Inference' },
        { value: 'batch-transform', label: 'Batch Transform' },
        { value: 'hyperpod-eks', label: 'HyperPod EKS' }
    ];

    // Load catalogs
    async function loadCatalogs() {
        const base = document.querySelector('script[src*="command-generator"]').src.replace('/js/command-generator.js', '/data');
        const [modelServers, modelSizes, instances, transformers, diffusors] = await Promise.all([
            fetch(`${base}/model-servers.json`).then(r => r.json()),
            fetch(`${base}/model-sizes.json`).then(r => r.json()),
            fetch(`${base}/instances.json`).then(r => r.json()),
            fetch(`${base}/popular-transformers.json`).then(r => r.json()),
            fetch(`${base}/popular-diffusors.json`).then(r => r.json())
        ]);
        catalogs = { modelServers, modelSizes, instances: instances.catalog || instances, transformers, diffusors };
    }

    // Get models list from catalogs
    function getModels() {
        const models = [];
        if (catalogs.modelSizes && catalogs.modelSizes.models) {
            for (const [name, info] of Object.entries(catalogs.modelSizes.models)) {
                if (name.endsWith('*')) continue;
                const gb = info.minVramGb || Math.ceil(info.parameterCount * 2 / 1e9);
                models.push({ value: name, label: `${name} (${gb}GB VRAM)`, ...info });
            }
        }
        if (catalogs.transformers) {
            for (const name of Object.keys(catalogs.transformers)) {
                if (!models.find(m => m.value === name)) {
                    models.push({ value: name, label: name });
                }
            }
        }
        return models.sort((a, b) => a.label.localeCompare(b.label));
    }

    // Get server versions for a config
    function getServerVersions() {
        const serverKey = state.deploymentConfig.split('-').slice(1).join('-')
            .replace('tensorrt-llm', 'tensorrt-llm')
            .replace('vllm-omni', 'vllm-omni')
            .replace('vllm', 'vllm')
            .replace('sglang', 'sglang')
            .replace('lmi', 'lmi')
            .replace('djl', 'djl');
        const key = state.deploymentConfig.includes('vllm-omni') ? 'vllm-omni'
            : state.deploymentConfig.includes('tensorrt') ? 'tensorrt-llm'
            : state.deploymentConfig.includes('sglang') ? 'sglang'
            : state.deploymentConfig.includes('lmi') ? 'lmi'
            : state.deploymentConfig.includes('djl') ? 'djl'
            : 'vllm';
        const versions = catalogs.modelServers?.[key] || [];
        return versions.map(v => ({
            value: v.tag,
            label: `${v.tag} (CUDA ${v.labels?.cuda_version || '?'})`,
            data: v
        }));
    }

    // Get GPU instances
    function getInstances() {
        if (!catalogs.instances) return [];
        return Object.entries(catalogs.instances)
            .filter(([, info]) => info.gpus > 0)
            .map(([name, info]) => ({
                value: name,
                label: `${name} (${info.gpus}× ${info.gpuType || info.hardware || '?'}, ${info.gpuMemoryGb || '?'}GB)`,
                ...info
            }))
            .sort((a, b) => (a.gpuMemoryGb || 0) - (b.gpuMemoryGb || 0));
    }

    // Auto-suggest instance from model
    function suggestInstance() {
        if (!catalogs.modelSizes?.models) return;
        const match = Object.entries(catalogs.modelSizes.models).find(([k]) => {
            const pattern = k.replace(/\*$/, '');
            return state.model.startsWith(pattern) || state.model === pattern;
        });
        if (match && match[1].recommendedInstances?.length) {
            state.instanceType = match[1].recommendedInstances[0];
            const inst = catalogs.instances?.[state.instanceType];
            if (inst) state.server.tp = inst.gpus || 1;
        }
    }

    // Generate the output command
    function generateOutput() {
        const lines = [];
        lines.push('#!/bin/bash');
        lines.push('# Generated by ML Container Creator Command Generator');
        lines.push('');

        // Primary command
        lines.push('# === Primary Model ===');
        let cmd = `ml-container-creator ${state.projectName}`;
        cmd += ` \\\n  --deployment-config=${state.deploymentConfig}`;
        if (state.model) cmd += ` \\\n  --model-name=${state.model}`;
        if (state.instanceType) cmd += ` \\\n  --instance-type=${state.instanceType}`;
        cmd += ` \\\n  --deployment-target=${state.deploymentTarget}`;
        if (state.features.benchmark) cmd += ` \\\n  --include-benchmark`;
        if (state.features.benchmark) {
            cmd += ` \\\n  --benchmark-concurrency=${state.benchmark.concurrency}`;
            cmd += ` \\\n  --benchmark-input-tokens=${state.benchmark.inputTokens}`;
            cmd += ` \\\n  --benchmark-output-tokens=${state.benchmark.outputTokens}`;
            if (state.benchmark.streaming) cmd += ` \\\n  --benchmark-streaming`;
        }
        cmd += ` \\\n  --skip-prompts`;
        lines.push(cmd);
        lines.push('');

        // Environment variables / server config
        const envLines = [];
        if (state.server.tp > 1) envLines.push(`VLLM_TENSOR_PARALLEL_SIZE=${state.server.tp}`);
        if (state.server.maxModelLen !== 4096) envLines.push(`VLLM_MAX_MODEL_LEN=${state.server.maxModelLen}`);
        if (state.server.gpuMemUtil !== 0.9) envLines.push(`VLLM_GPU_MEMORY_UTILIZATION=${state.server.gpuMemUtil}`);
        if (state.server.maxNumSeqs !== 256) envLines.push(`VLLM_MAX_NUM_SEQS=${state.server.maxNumSeqs}`);
        if (!state.server.prefixCaching) envLines.push(`VLLM_ENABLE_PREFIX_CACHING=false`);
        if (state.features.lora) {
            envLines.push(`VLLM_ENABLE_LORA=true`);
            envLines.push(`VLLM_MAX_LORAS=${state.lora.maxLoras}`);
            envLines.push(`VLLM_MAX_LORA_RANK=${state.lora.maxLoraRank}`);
        }
        state.envVars.forEach(ev => { if (ev.key && ev.value) envLines.push(`${ev.key}=${ev.value}`); });

        if (envLines.length) {
            lines.push('# Environment variables (add to Dockerfile or do/ic/default.conf):');
            envLines.forEach(l => lines.push(`# export ${l}`));
            lines.push('');
        }

        // IC config
        if (state.infra.startupTimeout !== 900 || state.infra.gpuCount || state.infra.copyCount !== 1) {
            lines.push('# IC configuration (do/ic/default.conf):');
            if (state.infra.startupTimeout !== 900) lines.push(`# IC_STARTUP_TIMEOUT=${state.infra.startupTimeout}`);
            if (state.infra.gpuCount) lines.push(`# IC_GPU_COUNT=${state.infra.gpuCount}`);
            if (state.infra.copyCount !== 1) lines.push(`# IC_COPY_COUNT=${state.infra.copyCount}`);
            lines.push('');
        }

        // Build & deploy
        lines.push(`cd ${state.projectName}`);
        lines.push('./do/build && ./do/push && ./do/deploy');
        lines.push('');

        // Additional ICs
        state.additionalICs.forEach((ic, i) => {
            if (!ic.model) return;
            lines.push(`# === Additional IC ${i + 1}: ${ic.model} ===`);
            let icCmd = `./do/add-ic ic-${i + 2}`;
            if (ic.modelData) icCmd += ` --model-data=${ic.modelData}`;
            lines.push(icCmd);
            lines.push('');
            // IC config overrides
            const icConf = [];
            icConf.push(`# do/ic/ic-${i + 2}.conf:`);
            icConf.push(`# IC_IMAGE_TAG="${state.projectName}-latest"`);
            if (ic.model) icConf.push(`# IC_CONTAINER_ENV_EXTRA='"VLLM_MODEL":"${ic.model}"${ic.tp ? ',"VLLM_TENSOR_PARALLEL_SIZE":"' + ic.tp + '"' : ''}${ic.maxModelLen ? ',"VLLM_MAX_MODEL_LEN":"' + ic.maxModelLen + '"' : ''}${ic.envOverrides ? ',' + ic.envOverrides.split(',').map(e => { const [k,v] = e.split('='); return `"${k.trim()}":"${(v||'').trim()}"`; }).join(',') : ''}'`);
            if (ic.gpuCount) icConf.push(`# IC_GPU_COUNT=${ic.gpuCount}`);
            if (ic.copyCount) icConf.push(`# IC_COPY_COUNT=${ic.copyCount}`);
            if (ic.minMemory) icConf.push(`# IC_MIN_MEMORY_MB=${ic.minMemory}`);
            if (ic.startupTimeout) icConf.push(`# IC_STARTUP_TIMEOUT=${ic.startupTimeout}`);
            icConf.forEach(l => lines.push(l));
            lines.push('');
        });

        // Adapters
        if (state.adapters.length) {
            const grouped = {};
            state.adapters.forEach(a => {
                if (!a.name || !a.path) return;
                const target = a.targetIc || 'primary';
                if (!grouped[target]) grouped[target] = [];
                grouped[target].push(a);
            });
            for (const [target, adapters] of Object.entries(grouped)) {
                const label = target === 'primary' ? 'Primary IC' : `IC ${target.replace('ic-', '')}`;
                lines.push(`# === LoRA Adapters (${label}) ===`);
                adapters.forEach(a => {
                    let cmd = `./do/adapter add --name=${a.name} --path=${a.path}`;
                    if (target !== 'primary') cmd += ` --ic=${target}`;
                    if (a.description) lines.push(`# ${a.description}`);
                    lines.push(cmd);
                });
                lines.push('');
            }
        }

        // Benchmark
        if (state.features.benchmark) {
            lines.push('# === Benchmark ===');
            lines.push('./do/benchmark');
            lines.push('');
        }

        return lines.join('\n');
    }

    // Render the widget
    function render() {
        const container = document.getElementById('mcc-command-generator');
        if (!container) return;

        const models = getModels();
        const versions = getServerVersions();
        const instances = getInstances();

        container.innerHTML = `
        <div class="mcc-gen">
            <div class="mcc-gen-form">
                <div class="mcc-section">
                    <h3>Model & Server</h3>
                    <label>Project Name
                        <input type="text" id="mcc-project" value="${state.projectName}">
                    </label>
                    <label>Model
                        <input type="text" id="mcc-model" list="mcc-model-list" value="${state.model}" placeholder="e.g. meta-llama/Llama-3.1-8B-Instruct">
                        <datalist id="mcc-model-list">
                            ${models.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
                        </datalist>
                    </label>
                    <label>Deployment Config
                        <select id="mcc-config">
                            ${DEPLOYMENT_CONFIGS.map(c => `<option value="${c.value}" ${c.value === state.deploymentConfig ? 'selected' : ''}>${c.label}</option>`).join('')}
                        </select>
                    </label>
                    <label>Server Version
                        <select id="mcc-version">
                            ${versions.map(v => `<option value="${v.value}" ${v.value === state.serverVersion ? 'selected' : ''}>${v.label}</option>`).join('')}
                        </select>
                    </label>
                </div>

                <div class="mcc-section">
                    <h3>Infrastructure</h3>
                    <label>Instance Type
                        <input type="text" id="mcc-instance" list="mcc-instance-list" value="${state.instanceType}" placeholder="e.g. ml.g5.2xlarge">
                        <datalist id="mcc-instance-list">
                            ${instances.map(i => `<option value="${i.value}">${i.label}</option>`).join('')}
                        </datalist>
                    </label>
                    <label>Deployment Target
                        <select id="mcc-target">
                            ${DEPLOYMENT_TARGETS.map(t => `<option value="${t.value}" ${t.value === state.deploymentTarget ? 'selected' : ''}>${t.label}</option>`).join('')}
                        </select>
                    </label>
                    <label>Tensor Parallel Size <input type="number" id="mcc-tp" value="${state.server.tp}" min="1" max="8"></label>
                    <label>Max Model Length <input type="number" id="mcc-maxlen" value="${state.server.maxModelLen}" min="512" step="512"></label>
                    <label>GPU Memory Utilization <input type="number" id="mcc-gpumem" value="${state.server.gpuMemUtil}" min="0.1" max="0.99" step="0.05"></label>
                    <label>IC Startup Timeout (s) <input type="number" id="mcc-timeout" value="${state.infra.startupTimeout}" min="60" step="60"></label>
                    <label>IC GPU Count <input type="number" id="mcc-icgpu" value="${state.infra.gpuCount}" min="0" max="8" placeholder="auto"></label>
                </div>

                <div class="mcc-section">
                    <h3>Features</h3>
                    <label class="mcc-check"><input type="checkbox" id="mcc-lora" ${state.features.lora ? 'checked' : ''}> Enable LoRA Adapters</label>
                    <div class="mcc-sub" ${state.features.lora ? '' : 'style="display:none"'} id="mcc-lora-opts">
                        <label>Max LoRAs <input type="number" id="mcc-maxloras" value="${state.lora.maxLoras}" min="1"></label>
                        <label>Max LoRA Rank <input type="number" id="mcc-maxrank" value="${state.lora.maxLoraRank}" min="8" step="8"></label>
                    </div>
                    <label class="mcc-check"><input type="checkbox" id="mcc-bench" ${state.features.benchmark ? 'checked' : ''}> Enable Benchmarking</label>
                    <div class="mcc-sub" ${state.features.benchmark ? '' : 'style="display:none"'} id="mcc-bench-opts">
                        <label>Concurrency <input type="number" id="mcc-bench-conc" value="${state.benchmark.concurrency}" min="1"></label>
                        <label>Input Tokens <input type="number" id="mcc-bench-in" value="${state.benchmark.inputTokens}" min="1"></label>
                        <label>Output Tokens <input type="number" id="mcc-bench-out" value="${state.benchmark.outputTokens}" min="1"></label>
                        <label class="mcc-check"><input type="checkbox" id="mcc-bench-stream" ${state.benchmark.streaming ? 'checked' : ''}> Streaming</label>
                    </div>
                </div>

                <div class="mcc-section">
                    <h3>Custom Environment Variables</h3>
                    <div id="mcc-envvars">
                        ${state.envVars.map((ev, i) => `
                            <div class="mcc-env-row">
                                <input type="text" placeholder="KEY" value="${ev.key}" data-idx="${i}" data-field="key" class="mcc-env-input">
                                <input type="text" placeholder="value" value="${ev.value}" data-idx="${i}" data-field="value" class="mcc-env-input">
                                <button class="mcc-btn-sm mcc-remove-env" data-idx="${i}">\u00d7</button>
                            </div>
                        `).join('')}
                    </div>
                    <button class="mcc-btn" id="mcc-add-env">+ Add Variable</button>
                </div>

                <div class="mcc-section">
                    <h3>Additional Inference Components</h3>
                    <div id="mcc-ics">
                        ${state.additionalICs.map((ic, i) => `
                            <div class="mcc-ic-block">
                                <div class="mcc-ic-header">
                                    <strong>IC ${i + 1}</strong>
                                    <button class="mcc-btn-sm mcc-remove-ic" data-idx="${i}">\u00d7 Remove</button>
                                </div>
                                <label>Model
                                    <input type="text" list="mcc-model-list" value="${ic.model}" data-idx="${i}" data-field="model" class="mcc-ic-input" placeholder="e.g. codellama/CodeLlama-7b-Instruct-hf">
                                </label>
                                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
                                    <label>GPU Count <input type="number" value="${ic.gpuCount}" data-idx="${i}" data-field="gpuCount" class="mcc-ic-input" min="1" max="8" placeholder="1"></label>
                                    <label>Copy Count <input type="number" value="${ic.copyCount}" data-idx="${i}" data-field="copyCount" class="mcc-ic-input" min="1" max="10" placeholder="1"></label>
                                    <label>Min Memory (MB) <input type="number" value="${ic.minMemory}" data-idx="${i}" data-field="minMemory" class="mcc-ic-input" min="128" step="128" placeholder="1024"></label>
                                    <label>Startup Timeout (s) <input type="number" value="${ic.startupTimeout}" data-idx="${i}" data-field="startupTimeout" class="mcc-ic-input" min="60" step="60" placeholder="900"></label>
                                    <label>Tensor Parallel <input type="number" value="${ic.tp}" data-idx="${i}" data-field="tp" class="mcc-ic-input" min="1" max="8" placeholder="1"></label>
                                    <label>Max Model Len <input type="number" value="${ic.maxModelLen}" data-idx="${i}" data-field="maxModelLen" class="mcc-ic-input" min="512" step="512" placeholder="4096"></label>
                                </div>
                                <label>Model Data (S3 URI, optional)
                                    <input type="text" value="${ic.modelData || ''}" data-idx="${i}" data-field="modelData" class="mcc-ic-input" placeholder="s3://bucket/model.tar.gz">
                                </label>
                                <label>Container Env Overrides (KEY=value, comma-separated)
                                    <input type="text" value="${ic.envOverrides || ''}" data-idx="${i}" data-field="envOverrides" class="mcc-ic-input" placeholder="VLLM_GPU_MEMORY_UTILIZATION=0.85,VLLM_MAX_NUM_SEQS=128">
                                </label>
                            </div>
                        `).join('')}
                    </div>
                    <button class="mcc-btn" id="mcc-add-ic">+ Add Inference Component</button>
                </div>

                <div class="mcc-section">
                    <h3>LoRA Adapters</h3>
                    <div id="mcc-adapters">
                        ${state.adapters.map((a, i) => `
                            <div class="mcc-ic-block">
                                <div class="mcc-ic-header">
                                    <strong>Adapter ${i + 1}</strong>
                                    <button class="mcc-btn-sm mcc-remove-adapter" data-idx="${i}">\u00d7 Remove</button>
                                </div>
                                <label>Adapter Name
                                    <input type="text" value="${a.name}" data-idx="${i}" data-field="name" class="mcc-adapter-input" placeholder="e.g. finance-lora-v2">
                                </label>
                                <label>Adapter Path (S3 URI)
                                    <input type="text" value="${a.path}" data-idx="${i}" data-field="path" class="mcc-adapter-input" placeholder="s3://my-bucket/adapters/finance-v2/">
                                </label>
                                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
                                    <label>Target IC
                                        <select data-idx="${i}" data-field="targetIc" class="mcc-adapter-input">
                                            <option value="primary" ${a.targetIc === 'primary' ? 'selected' : ''}>Primary IC</option>
                                            ${state.additionalICs.map((ic, j) => `<option value="ic-${j + 2}" ${a.targetIc === 'ic-' + (j+2) ? 'selected' : ''}>IC ${j + 2}${ic.model ? ' (' + ic.model.split('/').pop() + ')' : ''}</option>`).join('')}
                                        </select>
                                    </label>
                                    <label>Base Model (optional override)
                                        <input type="text" list="mcc-model-list" value="${a.baseModel || ''}" data-idx="${i}" data-field="baseModel" class="mcc-adapter-input" placeholder="Uses IC model if empty">
                                    </label>
                                </div>
                                <label>Description (optional)
                                    <input type="text" value="${a.description || ''}" data-idx="${i}" data-field="description" class="mcc-adapter-input" placeholder="e.g. Fine-tuned for financial document summarization">
                                </label>
                            </div>
                        `).join('')}
                    </div>
                    <button class="mcc-btn" id="mcc-add-adapter">+ Add Adapter</button>
                </div>
            </div>

            <div class="mcc-gen-output">
                <div class="mcc-output-header">
                    <h3>Generated Deployment Script</h3>
                    <div>
                        ${window.CoverageManifold && window.CoverageManifold.isLoaded() ? '<button class="mcc-show-manifold-btn" id="mcc-show-manifold">★ Show in Manifold</button>' : ''}
                        <button class="mcc-btn" id="mcc-copy">Copy</button>
                    </div>
                </div>
                <pre><code id="mcc-output">${generateOutput()}</code></pre>
            </div>
        </div>`;

        bindEvents();
    }

    function updateOutput() {
        const el = document.getElementById('mcc-output');
        if (el) el.textContent = generateOutput();
    }

    function bindEvents() {
        const on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };

        on('mcc-project', 'input', e => { state.projectName = e.target.value || 'my-project'; updateOutput(); });
        on('mcc-model', 'input', e => { state.model = e.target.value; suggestInstance(); render(); });
        on('mcc-config', 'change', e => { state.deploymentConfig = e.target.value; state.serverVersion = ''; render(); });
        on('mcc-version', 'change', e => { state.serverVersion = e.target.value; updateOutput(); });
        on('mcc-instance', 'input', e => {
            state.instanceType = e.target.value;
            const inst = catalogs.instances?.[e.target.value];
            if (inst && inst.gpus) { state.server.tp = inst.gpus; state.infra.gpuCount = inst.gpus; }
            render();
        });
        on('mcc-target', 'change', e => { state.deploymentTarget = e.target.value; updateOutput(); });
        on('mcc-tp', 'input', e => { state.server.tp = parseInt(e.target.value) || 1; updateOutput(); });
        on('mcc-maxlen', 'input', e => { state.server.maxModelLen = parseInt(e.target.value) || 4096; updateOutput(); });
        on('mcc-gpumem', 'input', e => { state.server.gpuMemUtil = parseFloat(e.target.value) || 0.9; updateOutput(); });
        on('mcc-timeout', 'input', e => { state.infra.startupTimeout = parseInt(e.target.value) || 900; updateOutput(); });
        on('mcc-icgpu', 'input', e => { state.infra.gpuCount = e.target.value ? parseInt(e.target.value) : ''; updateOutput(); });

        on('mcc-lora', 'change', e => { state.features.lora = e.target.checked; render(); });
        on('mcc-maxloras', 'input', e => { state.lora.maxLoras = parseInt(e.target.value) || 30; updateOutput(); });
        on('mcc-maxrank', 'input', e => { state.lora.maxLoraRank = parseInt(e.target.value) || 64; updateOutput(); });

        on('mcc-bench', 'change', e => { state.features.benchmark = e.target.checked; render(); });
        on('mcc-bench-conc', 'input', e => { state.benchmark.concurrency = parseInt(e.target.value) || 10; updateOutput(); });
        on('mcc-bench-in', 'input', e => { state.benchmark.inputTokens = parseInt(e.target.value) || 550; updateOutput(); });
        on('mcc-bench-out', 'input', e => { state.benchmark.outputTokens = parseInt(e.target.value) || 150; updateOutput(); });
        on('mcc-bench-stream', 'change', e => { state.benchmark.streaming = e.target.checked; updateOutput(); });

        on('mcc-add-env', 'click', () => { state.envVars.push({ key: '', value: '' }); render(); });
        on('mcc-add-ic', 'click', () => { state.additionalICs.push({ model: '', gpuCount: '', copyCount: '', minMemory: '', startupTimeout: '', tp: '', maxModelLen: '', modelData: '', envOverrides: '' }); render(); });
        on('mcc-add-adapter', 'click', () => { state.adapters.push({ name: '', path: '', targetIc: 'primary', baseModel: '', description: '' }); render(); });

        document.querySelectorAll('.mcc-remove-env').forEach(btn => btn.addEventListener('click', e => {
            state.envVars.splice(parseInt(e.target.dataset.idx), 1); render();
        }));
        document.querySelectorAll('.mcc-remove-ic').forEach(btn => btn.addEventListener('click', e => {
            state.additionalICs.splice(parseInt(e.target.dataset.idx), 1); render();
        }));
        document.querySelectorAll('.mcc-remove-adapter').forEach(btn => btn.addEventListener('click', e => {
            state.adapters.splice(parseInt(e.target.dataset.idx), 1); render();
        }));

        document.querySelectorAll('.mcc-env-input').forEach(el => el.addEventListener('input', e => {
            state.envVars[parseInt(e.target.dataset.idx)][e.target.dataset.field] = e.target.value; updateOutput();
        }));
        document.querySelectorAll('.mcc-ic-input').forEach(el => el.addEventListener('input', e => {
            state.additionalICs[parseInt(e.target.dataset.idx)][e.target.dataset.field] = e.target.value; updateOutput();
        }));
        document.querySelectorAll('.mcc-adapter-input').forEach(el => el.addEventListener('input', e => {
            state.adapters[parseInt(e.target.dataset.idx)][e.target.dataset.field] = e.target.value; updateOutput();
        }));

        on('mcc-copy', 'click', () => {
            navigator.clipboard.writeText(generateOutput());
            const btn = document.getElementById('mcc-copy');
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        });

        on('mcc-show-manifold', 'click', () => {
            if (window.CoverageManifold && window.CoverageManifold.isLoaded()) {
                const modelName = state.model || '';
                const instanceType = state.instanceType || '';
                const lower = modelName.toLowerCase();
                let modelFamily = 'qwen3';
                if (lower.includes('qwen3') || lower.includes('qwen-3')) modelFamily = 'qwen3';
                else if (lower.includes('qwen2.5')) modelFamily = 'qwen2.5';
                else if (lower.includes('llama-3') || lower.includes('llama3')) modelFamily = 'llama3';
                else if (lower.includes('deepseek-r1')) modelFamily = 'deepseek-r1';
                else if (lower.includes('mistral')) modelFamily = 'mistral';
                else if (lower.includes('gemma')) modelFamily = 'gemma2';
                else if (lower.includes('phi')) modelFamily = 'phi3';

                const instMatch = instanceType.match(/ml\.([a-z]+\d+[a-z]*)\./);
                const instanceFamily = instMatch ? instMatch[1] : 'g5';

                let target = state.deploymentTarget;
                if (target === 'managed-inference') target = 'realtime-inference';

                const config = {
                    deployment_config: state.deploymentConfig,
                    model_family: modelFamily,
                    instance_family: instanceFamily,
                    quantization: 'none',
                    tp_degree: String(state.server.tp || 1),
                    enable_lora: String(state.features.lora || false),
                    deployment_target: target
                };
                window.CoverageManifold.plotConfig(config);

                // Scroll to manifold if it exists on the page
                const manifoldEl = document.getElementById('coverage-manifold');
                if (manifoldEl) manifoldEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }

    // Init
    async function init() {
        const container = document.getElementById('mcc-command-generator');
        if (!container) return;
        container.innerHTML = '<p>Loading catalogs...</p>';
        try {
            await loadCatalogs();
            const versions = getServerVersions();
            if (versions.length) state.serverVersion = versions[0].value;
            render();
        } catch (err) {
            container.innerHTML = `<p style="color:red">Failed to load catalogs: ${err.message}</p>`;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
