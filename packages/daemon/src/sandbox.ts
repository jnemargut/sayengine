// Code mode sandbox (Decision 5): scripts run inside QuickJS compiled to WebAssembly.
// The guest has no filesystem, network, timers, process or require — only `studio.*`
// (every registry tool, each call a normal commit) and `console.log`.
// Limits: 5 s wall clock, 64 MB heap, 1 MB stack.
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

export interface SandboxResult { ok: boolean; error?: string; logs: string[] }

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export async function runSandboxed(
  src: string,
  toolNames: string[],
  call: (tool: string, args: object) => unknown,
  opts: { timeoutMs?: number; memoryBytes?: number; filename?: string } = {},
): Promise<SandboxResult> {
  const QuickJS = await getQuickJS();
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(opts.memoryBytes ?? 64 * 1024 * 1024);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (opts.timeoutMs ?? 5000)));
  const vm = rt.newContext();
  const logs: string[] = [];
  try {
    const hostCall = vm.newFunction('__call', (toolH, argsH) => {
      const tool = vm.getString(toolH);
      const args = JSON.parse(vm.getString(argsH) || '{}');
      try {
        return vm.newString(JSON.stringify({ ok: true, value: call(tool, args) ?? null }));
      } catch (e: any) {
        return vm.newString(JSON.stringify({ ok: false, error: e.message ?? String(e) }));
      }
    });
    vm.setProp(vm.global, '__call', hostCall);
    hostCall.dispose();
    const hostLog = vm.newFunction('__log', (s) => { logs.push(vm.getString(s)); });
    vm.setProp(vm.global, '__log', hostLog);
    hostLog.dispose();

    const prelude = `(() => {
      const hostCall = globalThis.__call, hostLog = globalThis.__log;
      delete globalThis.__call; delete globalThis.__log;
      const __invoke = (tool, args) => {
        const r = JSON.parse(hostCall(tool, JSON.stringify(args ?? {})));
        if (!r.ok) throw new Error(tool + ': ' + r.error);
        return r.value;
      };
      const studio = { call: __invoke };
      for (const [n, c] of ${JSON.stringify(toolNames.map((n) => [n, camel(n)]))}) studio[c] = (a) => __invoke(n, a);
      Object.freeze(studio);
      const __fmt = (x) => typeof x === 'string' ? x : JSON.stringify(x);
      const console = { log: (...xs) => hostLog(xs.map(__fmt).join(' ')) };
      globalThis.studio = studio; globalThis.console = console;
    })();`;
    const pre = vm.evalCode(prelude, 'prelude.js');
    if (pre.error) { const e = vm.dump(pre.error); pre.error.dispose(); return { ok: false, error: `prelude: ${JSON.stringify(e)}`, logs }; }
    pre.value.dispose();

    const res = vm.evalCode(src, opts.filename ?? 'script.js');
    if (res.error) {
      const e = vm.dump(res.error);
      res.error.dispose();
      const msg = typeof e === 'object' && e ? `${e.name ?? 'Error'}: ${e.message ?? JSON.stringify(e)}` : String(e);
      return { ok: false, error: /interrupted/i.test(msg) ? `script timed out after ${(opts.timeoutMs ?? 5000) / 1000} s` : msg, logs };
    }
    res.value.dispose();
    return { ok: true, logs };
  } finally {
    vm.dispose();
    rt.dispose();
  }
}
