/**
 * Coverage Manifold — D3.js interactive scatter plot visualization
 *
 * Renders all known configurations as points in a 2D scatter plot with:
 * - Color = status (green=proven, red=failed, grey=unfeasible)
 * - Size = throughput_rps (default)
 * - Shape = deployment_target (circle=realtime, square=async, triangle=batch, diamond=hyperpod)
 * - Hover = tooltip with metrics
 * - Click = detail panel for proven points
 * - "Plot my config" = project user config as ★ with connectors to 3 nearest
 * - Filtering = deployment_config, model_family, instance_family
 * - Dark regions = semi-transparent grey for low-density areas
 *
 * Requirements: 9.1–9.15
 */
(function () {
    'use strict'

    // --- Constants ---
    const STATUS_COLORS = {
        proven: '#2ecc40',
        passed: '#2ecc40',
        completed: '#2ecc40',
        failed: '#ff4136',
        unfeasible: '#aaaaaa',
        untested: '#aaaaaa'
    }

    const SHAPE_MAP = {
        'realtime-inference': 'circle',
        'async-inference': 'square',
        'batch-transform': 'triangle',
        'hyperpod-eks': 'diamond'
    }

    const MARGIN = { top: 30, right: 30, bottom: 50, left: 50 }
    const MIN_RADIUS = 4
    const MAX_RADIUS = 18

    let manifoldData = null
    let svg = null
    let xScale = null
    let yScale = null
    let radiusScale = null
    let tooltip = null
    let activeFilters = { deployment_config: null, model_family: null, instance_family: null }
    let userStar = null
    let connectorLines = []

    // --- Data Loading ---

    async function loadManifoldData() {
        const base = getBaseUrl()
        try {
            const response = await fetch(`${base}/data/coverage-manifold.json`)
            if (!response.ok) return null
            const data = await response.json()
            if (!data.points || data.points.length === 0) return null
            return data
        } catch (e) {
            return null
        }
    }

    function getBaseUrl() {
        const script = document.querySelector('script[src*="coverage-manifold"]')
        if (script) return script.src.replace('/js/coverage-manifold.js', '')
        return '.'
    }

    // --- Filtering (Task 7.7) ---

    function getFilteredPoints() {
        if (!manifoldData) return []
        return manifoldData.points.filter(p => {
            if (activeFilters.deployment_config && p.deployment_config !== activeFilters.deployment_config) return false
            if (activeFilters.model_family && p.model_family !== activeFilters.model_family) return false
            if (activeFilters.instance_family && p.instance_family !== activeFilters.instance_family) return false
            return true
        })
    }

    // --- Shape Rendering ---

    function drawShape(selection, shape, size) {
        selection.each(function (d) {
            const el = d3.select(this)
            el.selectAll('*').remove()
            const r = size(d)
            const target = d.deployment_target || 'realtime-inference'
            const s = SHAPE_MAP[target] || 'circle'

            if (s === 'circle') {
                el.append('circle').attr('r', r)
            } else if (s === 'square') {
                const side = r * 1.6
                el.append('rect')
                    .attr('x', -side / 2).attr('y', -side / 2)
                    .attr('width', side).attr('height', side)
            } else if (s === 'triangle') {
                const h = r * 2
                el.append('polygon')
                    .attr('points', `0,${-h / 2} ${h / 2},${h / 2} ${-h / 2},${h / 2}`)
            } else if (s === 'diamond') {
                const h = r * 2
                el.append('polygon')
                    .attr('points', `0,${-h / 2} ${h / 2},0 0,${h / 2} ${-h / 2},0`)
            }

            el.select('circle, rect, polygon')
                .attr('fill', getColor(d))
                .attr('stroke', '#333')
                .attr('stroke-width', 0.5)
                .attr('opacity', 0.85)
        })
    }

    function getColor(d) {
        return STATUS_COLORS[d.status] || STATUS_COLORS.untested
    }

    // --- Tooltip (Task 7.4) ---

    function showTooltip(event, d) {
        if (!tooltip) return
        const html = `
            <strong>${d.model_name}</strong><br>
            <span class="manifold-tt-label">Instance:</span> ${d.instance_type}<br>
            <span class="manifold-tt-label">Config:</span> ${d.deployment_config}<br>
            <span class="manifold-tt-label">Throughput:</span> ${d.throughput_rps} rps<br>
            <span class="manifold-tt-label">TTFT p50:</span> ${d.ttft_p50_ms} ms<br>
            <span class="manifold-tt-label">Status:</span> ${d.status}<br>
            <span class="manifold-tt-label">Run Type:</span> ${d.run_type}
        `
        tooltip.html(html)
            .style('left', `${event.pageX + 12}px`)
            .style('top', `${event.pageY - 10}px`)
            .style('opacity', 1)
    }

    function hideTooltip() {
        if (tooltip) tooltip.style('opacity', 0)
    }

    // --- Click Interaction (Task 7.4) ---

    function handleClick(event, d) {
        if (d.status === 'proven' || d.status === 'passed' || d.status === 'completed') {
            showDetailPanel(d)
        }
    }

    function showDetailPanel(d) {
        let panel = document.getElementById('manifold-detail-panel')
        if (!panel) {
            panel = document.createElement('div')
            panel.id = 'manifold-detail-panel'
            panel.className = 'manifold-detail-panel'
            document.querySelector('.manifold-container').appendChild(panel)
        }
        panel.innerHTML = `
            <div class="manifold-detail-header">
                <h4>Configuration Detail</h4>
                <button class="manifold-detail-close">&times;</button>
            </div>
            <table class="manifold-detail-table">
                <tr><td>Config ID</td><td><code>${d.configId}</code></td></tr>
                <tr><td>Model</td><td>${d.model_name}</td></tr>
                <tr><td>Instance</td><td>${d.instance_type}</td></tr>
                <tr><td>Deployment Config</td><td>${d.deployment_config}</td></tr>
                <tr><td>Target</td><td>${d.deployment_target}</td></tr>
                <tr><td>Quantization</td><td>${d.quantization}</td></tr>
                <tr><td>TP Degree</td><td>${d.tp_degree}</td></tr>
                <tr><td>LoRA</td><td>${d.enable_lora}</td></tr>
                <tr><td>Throughput</td><td>${d.throughput_rps} rps</td></tr>
                <tr><td>TTFT p50</td><td>${d.ttft_p50_ms} ms</td></tr>
                <tr><td>Status</td><td>${d.status}</td></tr>
                <tr><td>Run Type</td><td>${d.run_type}</td></tr>
            </table>
        `
        panel.style.display = 'block'
        panel.querySelector('.manifold-detail-close').addEventListener('click', () => {
            panel.style.display = 'none'
        })
    }

    // --- Dark Region Highlighting (Task 7.5) ---

    function renderDarkRegions(svgGroup, points, width, height) {
        svgGroup.selectAll('.manifold-dark-region').remove()

        if (points.length < 5) return

        // Grid-based density estimation
        const gridSize = 40
        const cols = Math.ceil(width / gridSize)
        const rows = Math.ceil(height / gridSize)
        const grid = Array.from({ length: rows }, () => new Array(cols).fill(0))

        points.forEach(p => {
            const px = xScale(p.x)
            const py = yScale(p.y)
            const col = Math.floor(px / gridSize)
            const row = Math.floor(py / gridSize)
            if (col >= 0 && col < cols && row >= 0 && row < rows) {
                grid[row][col]++
            }
        })

        // Threshold: cells with 0 points and neighbors with <= 1 point
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (grid[r][c] === 0) {
                    // Check if neighbors also have low density
                    let neighborCount = 0
                    for (let dr = -1; dr <= 1; dr++) {
                        for (let dc = -1; dc <= 1; dc++) {
                            const nr = r + dr, nc = c + dc
                            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                                neighborCount += grid[nr][nc]
                            }
                        }
                    }
                    if (neighborCount <= 1) {
                        svgGroup.append('rect')
                            .attr('class', 'manifold-dark-region')
                            .attr('x', c * gridSize)
                            .attr('y', r * gridSize)
                            .attr('width', gridSize)
                            .attr('height', gridSize)
                            .attr('fill', '#999')
                            .attr('opacity', 0.08)
                            .attr('pointer-events', 'none')
                    }
                }
            }
        }
    }

    // --- PCA Projection (Task 7.6) ---

    function projectConfig(userConfig, data) {
        if (!data || !data.encoding_maps || !data.pca_components || !data.pca_mean) return null

        const encoded = data.dimensions_used.map(dim => {
            const value = String(userConfig[dim] ?? '')
            return data.encoding_maps[dim]?.[value] ?? 0
        })

        const centered = encoded.map((v, i) => v - data.pca_mean[i])

        const x = data.pca_components[0].reduce((sum, w, i) => sum + w * centered[i], 0)
        const y = data.pca_components[1].reduce((sum, w, i) => sum + w * centered[i], 0)

        return { x, y }
    }

    // --- Nearest Neighbor (Task 7.6) ---

    function findNearestProven(point, points, k = 3) {
        const proven = points.filter(p =>
            p.status === 'proven' || p.status === 'passed' || p.status === 'completed'
        )
        if (proven.length === 0) return []

        const withDist = proven.map(p => ({
            point: p,
            distance: Math.sqrt((p.x - point.x) ** 2 + (p.y - point.y) ** 2)
        }))
        withDist.sort((a, b) => a.distance - b.distance)
        return withDist.slice(0, k)
    }

    // --- Plot My Config (Task 7.6) ---

    function plotUserConfig(userConfig) {
        if (!manifoldData || !svg || !xScale || !yScale) return

        // Remove existing star and connectors
        clearUserPlot()

        const projected = projectConfig(userConfig, manifoldData)
        if (!projected) return

        const plotGroup = svg.select('.manifold-plot-group')
        const points = getFilteredPoints()

        // Draw star marker
        const starPath = d3.symbol().type(d3.symbolStar).size(200)
        userStar = plotGroup.append('path')
            .attr('class', 'manifold-user-star')
            .attr('d', starPath)
            .attr('transform', `translate(${xScale(projected.x)}, ${yScale(projected.y)})`)
            .attr('fill', '#ff851b')
            .attr('stroke', '#111')
            .attr('stroke-width', 1.5)

        // Find and draw connectors to 3 nearest proven points
        const nearest = findNearestProven(projected, points, 3)
        nearest.forEach(n => {
            const line = plotGroup.append('line')
                .attr('class', 'manifold-connector')
                .attr('x1', xScale(projected.x))
                .attr('y1', yScale(projected.y))
                .attr('x2', xScale(n.point.x))
                .attr('y2', yScale(n.point.y))
                .attr('stroke', '#ff851b')
                .attr('stroke-width', 1.2)
                .attr('stroke-dasharray', '4 3')
                .attr('opacity', 0.7)
            connectorLines.push(line)
        })
    }

    function clearUserPlot() {
        if (svg) {
            svg.selectAll('.manifold-user-star').remove()
            svg.selectAll('.manifold-connector').remove()
        }
        userStar = null
        connectorLines = []
    }

    // --- Main Render ---

    function renderManifold(container) {
        const points = getFilteredPoints()
        if (points.length === 0) {
            container.innerHTML = renderPlaceholder()
            return
        }

        const width = container.clientWidth || 800
        const height = 500
        const plotWidth = width - MARGIN.left - MARGIN.right
        const plotHeight = height - MARGIN.top - MARGIN.bottom

        // Clear previous
        container.innerHTML = ''

        // Build controls
        const controls = document.createElement('div')
        controls.className = 'manifold-controls'
        controls.innerHTML = buildFilterControls()
        container.appendChild(controls)

        // SVG
        const svgEl = d3.select(container).append('svg')
            .attr('width', width)
            .attr('height', height)
            .attr('class', 'manifold-svg')

        svg = svgEl

        const g = svgEl.append('g')
            .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`)
            .attr('class', 'manifold-plot-group')

        // Scales
        const xExtent = d3.extent(points, d => d.x)
        const yExtent = d3.extent(points, d => d.y)
        const xPadding = (xExtent[1] - xExtent[0]) * 0.1 || 1
        const yPadding = (yExtent[1] - yExtent[0]) * 0.1 || 1

        xScale = d3.scaleLinear()
            .domain([xExtent[0] - xPadding, xExtent[1] + xPadding])
            .range([0, plotWidth])

        yScale = d3.scaleLinear()
            .domain([yExtent[0] - yPadding, yExtent[1] + yPadding])
            .range([plotHeight, 0])

        const maxThru = d3.max(points, d => d.throughput_rps) || 100
        radiusScale = d3.scaleSqrt()
            .domain([0, maxThru])
            .range([MIN_RADIUS, MAX_RADIUS])

        // Axes
        g.append('g')
            .attr('transform', `translate(0,${plotHeight})`)
            .call(d3.axisBottom(xScale).ticks(6))
            .attr('class', 'manifold-axis')

        g.append('g')
            .call(d3.axisLeft(yScale).ticks(6))
            .attr('class', 'manifold-axis')

        // Axis labels
        svgEl.append('text')
            .attr('x', MARGIN.left + plotWidth / 2)
            .attr('y', height - 8)
            .attr('text-anchor', 'middle')
            .attr('class', 'manifold-axis-label')
            .text('PC1')

        svgEl.append('text')
            .attr('transform', 'rotate(-90)')
            .attr('x', -(MARGIN.top + plotHeight / 2))
            .attr('y', 14)
            .attr('text-anchor', 'middle')
            .attr('class', 'manifold-axis-label')
            .text('PC2')

        // Dark regions (Task 7.5)
        renderDarkRegions(g, points, plotWidth, plotHeight)

        // Points
        const pointGroups = g.selectAll('.manifold-point')
            .data(points)
            .enter()
            .append('g')
            .attr('class', 'manifold-point')
            .attr('transform', d => `translate(${xScale(d.x)},${yScale(d.y)})`)
            .on('mouseenter', showTooltip)
            .on('mouseleave', hideTooltip)
            .on('click', handleClick)
            .style('cursor', d =>
                (d.status === 'proven' || d.status === 'passed' || d.status === 'completed')
                    ? 'pointer' : 'default'
            )

        drawShape(pointGroups, SHAPE_MAP, d => radiusScale(d.throughput_rps || 1))

        // Tooltip element
        if (!tooltip) {
            tooltip = d3.select('body').append('div')
                .attr('class', 'manifold-tooltip')
                .style('opacity', 0)
        }

        // Legend
        renderLegend(container)

        // Bind filter events
        bindFilterEvents(container)
    }

    // --- Filter Controls (Task 7.7) ---

    function buildFilterControls() {
        if (!manifoldData) return ''

        const deploymentConfigs = [...new Set(manifoldData.points.map(p => p.deployment_config))].sort()
        const modelFamilies = [...new Set(manifoldData.points.map(p => p.model_family))].sort()
        const instanceFamilies = [...new Set(manifoldData.points.map(p => p.instance_family))].sort()

        return `
            <div class="manifold-filter-row">
                <label>Deployment Config
                    <select id="manifold-filter-dc">
                        <option value="">All</option>
                        ${deploymentConfigs.map(c => `<option value="${c}" ${activeFilters.deployment_config === c ? 'selected' : ''}>${c}</option>`).join('')}
                    </select>
                </label>
                <label>Model Family
                    <select id="manifold-filter-mf">
                        <option value="">All</option>
                        ${modelFamilies.map(c => `<option value="${c}" ${activeFilters.model_family === c ? 'selected' : ''}>${c}</option>`).join('')}
                    </select>
                </label>
                <label>Instance Family
                    <select id="manifold-filter-if">
                        <option value="">All</option>
                        ${instanceFamilies.map(c => `<option value="${c}" ${activeFilters.instance_family === c ? 'selected' : ''}>${c}</option>`).join('')}
                    </select>
                </label>
                <button id="manifold-plot-my-config" class="manifold-btn" title="Plot current Command Generator config on the manifold">★ Plot My Config</button>
            </div>
        `
    }

    function bindFilterEvents(container) {
        const dcSelect = document.getElementById('manifold-filter-dc')
        const mfSelect = document.getElementById('manifold-filter-mf')
        const ifSelect = document.getElementById('manifold-filter-if')
        const plotBtn = document.getElementById('manifold-plot-my-config')

        if (dcSelect) dcSelect.addEventListener('change', e => {
            activeFilters.deployment_config = e.target.value || null
            renderManifold(container)
        })
        if (mfSelect) mfSelect.addEventListener('change', e => {
            activeFilters.model_family = e.target.value || null
            renderManifold(container)
        })
        if (ifSelect) ifSelect.addEventListener('change', e => {
            activeFilters.instance_family = e.target.value || null
            renderManifold(container)
        })
        if (plotBtn) plotBtn.addEventListener('click', () => {
            const config = extractCommandGeneratorConfig()
            if (config) plotUserConfig(config)
        })
    }

    // --- Legend ---

    function renderLegend(container) {
        const legend = document.createElement('div')
        legend.className = 'manifold-legend'
        legend.innerHTML = `
            <div class="manifold-legend-section">
                <strong>Status:</strong>
                <span class="manifold-legend-item"><span class="manifold-dot" style="background:${STATUS_COLORS.proven}"></span> Proven</span>
                <span class="manifold-legend-item"><span class="manifold-dot" style="background:${STATUS_COLORS.failed}"></span> Failed</span>
                <span class="manifold-legend-item"><span class="manifold-dot" style="background:${STATUS_COLORS.unfeasible}"></span> Unfeasible</span>
            </div>
            <div class="manifold-legend-section">
                <strong>Shape:</strong>
                <span class="manifold-legend-item">&#9679; Realtime</span>
                <span class="manifold-legend-item">&#9632; Async</span>
                <span class="manifold-legend-item">&#9650; Batch</span>
                <span class="manifold-legend-item">&#9670; HyperPod</span>
            </div>
            <div class="manifold-legend-section">
                <strong>Size:</strong> Throughput (rps)
            </div>
        `
        container.appendChild(legend)
    }

    // --- Placeholder (Task 7.8) ---

    function renderPlaceholder() {
        return `
            <div class="manifold-placeholder">
                <div class="manifold-placeholder-icon">&#128506;</div>
                <h3>Coverage Manifold</h3>
                <p>No coverage manifold data available yet.</p>
                <p>Coverage data will populate after benchmark runs complete in CI.
                   Run <code>node scripts/codegen-manifold.js --sample</code> locally for a preview with synthetic data.</p>
            </div>
        `
    }

    // --- Command Generator Integration (Task 7.9) ---

    function extractCommandGeneratorConfig() {
        // Read from the Command Generator widget state if available
        const dcEl = document.getElementById('mcc-config')
        const modelEl = document.getElementById('mcc-model')
        const instanceEl = document.getElementById('mcc-instance')
        const targetEl = document.getElementById('mcc-target')
        const tpEl = document.getElementById('mcc-tp')
        const loraEl = document.getElementById('mcc-lora')

        if (!dcEl && !modelEl) return null

        const modelName = modelEl?.value || ''
        const instanceType = instanceEl?.value || ''

        return {
            deployment_config: dcEl?.value || 'transformers-vllm',
            model_family: deriveModelFamily(modelName),
            instance_family: deriveInstanceFamily(instanceType),
            quantization: 'none',
            tp_degree: String(tpEl?.value || '1'),
            enable_lora: String(loraEl?.checked || false),
            deployment_target: mapTarget(targetEl?.value || 'managed-inference')
        }
    }

    function deriveModelFamily(modelName) {
        if (!modelName) return 'qwen3'
        const lower = modelName.toLowerCase()
        if (lower.includes('qwen3') || lower.includes('qwen-3')) return 'qwen3'
        if (lower.includes('qwen2.5') || lower.includes('qwen-2.5')) return 'qwen2.5'
        if (lower.includes('llama-3') || lower.includes('llama3')) return 'llama3'
        if (lower.includes('deepseek-r1') || lower.includes('deepseek_r1')) return 'deepseek-r1'
        if (lower.includes('mistral')) return 'mistral'
        if (lower.includes('gemma')) return 'gemma2'
        if (lower.includes('phi-3') || lower.includes('phi3')) return 'phi3'
        if (lower.includes('gpt-oss') || lower.includes('gptoss')) return 'gpt-oss'
        if (lower.includes('starcoder')) return 'starcoder2'
        if (lower.includes('falcon')) return 'falcon'
        return 'qwen3'
    }

    function deriveInstanceFamily(instanceType) {
        if (!instanceType) return 'g5'
        const match = instanceType.match(/ml\.([a-z]+\d+[a-z]*)\./)
        return match ? match[1] : 'g5'
    }

    function mapTarget(target) {
        if (target === 'managed-inference') return 'realtime-inference'
        return target
    }

    // --- Public API (for Command Generator integration) ---

    window.CoverageManifold = {
        plotConfig: plotUserConfig,
        clearPlot: clearUserPlot,
        projectConfig,
        findNearestProven,
        getFilteredPoints,
        isLoaded: () => manifoldData !== null
    }

    // --- Initialization ---

    async function init() {
        const container = document.getElementById('coverage-manifold')
        if (!container) return

        container.innerHTML = '<p class="manifold-loading">Loading coverage manifold...</p>'
        container.classList.add('manifold-container')

        manifoldData = await loadManifoldData()

        if (!manifoldData) {
            container.innerHTML = renderPlaceholder()
            return
        }

        renderManifold(container)
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init)
    } else {
        init()
    }
})()
