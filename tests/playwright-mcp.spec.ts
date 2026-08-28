import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openPlaywrightMcp } from '../src/playwright-mcp.js'

test('official Playwright MCP core catalog is available over in-memory transport', async () => {
  const connection = await openPlaywrightMcp({}, async () => { throw new Error('catalog listing must not require a browser') })
  try {
    const tools = await connection.listTools()
    const names = tools.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
      'browser_evaluate', 'browser_file_upload', 'browser_fill_form', 'browser_find', 'browser_handle_dialog',
      'browser_hover', 'browser_navigate', 'browser_navigate_back', 'browser_network_request',
      'browser_network_requests', 'browser_press_key', 'browser_resize', 'browser_run_code_unsafe',
      'browser_select_option', 'browser_snapshot', 'browser_tabs', 'browser_take_screenshot', 'browser_type',
      'browser_wait_for',
    ].sort())
  } finally {
    await connection.close()
  }
})
