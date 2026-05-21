---
hide:
  - navigation
  - toc
---

# Command Generator

Use this interactive tool to generate a complete ML Container Creator deployment script. Configure your model, server, infrastructure, adapters, and additional inference components — the script updates in real-time.

<style>
.mcc-gen { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 1rem; }
@media (max-width: 1200px) { .mcc-gen { grid-template-columns: 1fr; } }
.mcc-gen-form { display: flex; flex-direction: column; gap: 0.5rem; }
.mcc-gen-output { position: sticky; top: 4rem; align-self: start; }
.mcc-gen-output pre { max-height: 80vh; overflow-y: auto; font-size: 0.8rem; background: var(--md-code-bg-color); padding: 1rem; border-radius: 4px; }
.mcc-output-header { display: flex; justify-content: space-between; align-items: center; }
.mcc-section { border: 1px solid var(--md-default-fg-color--lightest); border-radius: 6px; padding: 1rem; margin-bottom: 0.5rem; }
.mcc-section h3 { margin: 0 0 0.75rem 0; font-size: 1rem; }
.mcc-section label { display: block; font-size: 0.85rem; margin-bottom: 0.5rem; color: var(--md-default-fg-color--light); }
.mcc-section input[type="text"],
.mcc-section input[type="number"],
.mcc-section select { display: block; width: 100%; padding: 0.4rem 0.5rem; margin-top: 0.2rem; border: 1px solid var(--md-default-fg-color--lightest); border-radius: 4px; font-size: 0.85rem; background: var(--md-default-bg-color); color: var(--md-default-fg-color); }
.mcc-check { display: flex !important; align-items: center; gap: 0.5rem; }
.mcc-check input[type="checkbox"] { width: auto; margin: 0; }
.mcc-sub { padding-left: 1.5rem; border-left: 2px solid var(--md-accent-fg-color); margin: 0.5rem 0; }
.mcc-btn { background: var(--md-accent-fg-color); color: white; border: none; padding: 0.4rem 0.8rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
.mcc-btn:hover { opacity: 0.9; }
.mcc-btn-sm { background: transparent; border: 1px solid var(--md-default-fg-color--lightest); color: var(--md-default-fg-color--light); padding: 0.2rem 0.5rem; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
.mcc-env-row, .mcc-ic-row, .mcc-adapter-row { display: flex; gap: 0.5rem; margin-bottom: 0.4rem; align-items: center; }
.mcc-env-row input, .mcc-ic-row input, .mcc-adapter-row input { flex: 1; margin-top: 0 !important; }
.mcc-ic-block { border: 1px solid var(--md-default-fg-color--lightest); border-radius: 4px; padding: 0.75rem; margin-bottom: 0.75rem; background: var(--md-code-bg-color); }
.mcc-ic-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
.md-content { max-width: none; }
</style>

<div id="mcc-command-generator">
    <p><em>Loading...</em></p>
</div>
