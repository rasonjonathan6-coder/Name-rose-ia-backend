/**
 * Generates the MV3 manifest. Chrome/Edge reject SVG for toolbar icons, so the
 * PNGs referenced here are produced by gen-icons.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';
export const EXTENSION_NAME = 'ROSE IA — Real-time Chat Assistant';

/** Host patterns the content script is allowed to attach to. */
const PLATFORM_MATCHES = [
  'https://coomeet.com/*',
  'https://*.coomeet.com/*',
  'https://flirtify.com/*',
  'https://*.flirtify.com/*',
  // Demo harness served locally by `npm run demo`.
  'http://localhost/*',
  'http://127.0.0.1/*',
];

export function buildManifest({ prod = false } = {}) {
  // The proxy backend's origin can be declared at build time so the extension
  // can call it without a runtime permission prompt. It is not a secret — a
  // public endpoint URL — but it is optional: the backend answers permissive
  // CORS, so a cross-origin fetch works even without this.
  const backendOrigin = process.env.ROSE_BACKEND_ORIGIN?.trim().replace(/\/+$/, '') ?? '';
  const backendHostPattern = backendOrigin ? `${backendOrigin}/*` : null;

  return {
    manifest_version: 3,
    name: EXTENSION_NAME,
    short_name: 'ROSE IA',
    version: VERSION,
    description:
      'Real-time conversational AI assistant for online chat and webcam platforms. Generic engine with per-platform adapters, client memory, translation and manual/assisted/auto reply modes.',
    minimum_chrome_version: '110',
    action: {
      default_title: 'ROSE IA',
      default_popup: 'popup/popup.html',
      default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' },
    },
    icons: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
    background: { service_worker: 'background.js', type: 'module' },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    side_panel: { default_path: 'sidepanel/sidepanel.html' },
    // `tabs` is needed only to open the dashboard in a tab; `storage` for
    // persisted settings/memory; `scripting` for user-triggered re-injection on
    // sites the user explicitly enables; `permissions` to request that host
    // access at runtime.
    permissions: ['storage', 'scripting', 'tabs', 'notifications', 'alarms', 'permissions'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    host_permissions: [
      ...(prod
        ? [
            'https://api.openai.com/*',
            'https://openrouter.ai/*',
            'https://api.groq.com/*',
            'https://generativelanguage.googleapis.com/*',
            'https://text.pollinations.ai/*',
          ]
        : [
            'https://api.openai.com/*',
            'https://openrouter.ai/*',
            'https://api.groq.com/*',
            'https://generativelanguage.googleapis.com/*',
            'https://text.pollinations.ai/*',
            'http://localhost/*',
            'http://127.0.0.1/*',
          ]),
      ...(backendHostPattern ? [backendHostPattern] : []),
    ],
    content_scripts: [
      {
        matches: PLATFORM_MATCHES,
        js: ['content.js'],
        run_at: 'document_idle',
        // Some platforms host the chat in a child frame: CooMeet serves a shell
        // on www.coomeet.com and mounts the chat on iframe.coomeet.com. With
        // `all_frames: false` the script only ran in the shell, so the chat was
        // invisible. Attaching to child frames too is what makes that platform
        // reachable; the content script then decides per frame whether it is the
        // UI owner or just a pipeline runner (see src/content/frame-role.ts), so
        // this does not produce one overlay per frame.
        //
        // `match_about_blank` stays false: an about:blank frame has no chat.
        all_frames: true,
        match_about_blank: false,
      },
    ],
    web_accessible_resources: [
      {
        resources: ['icons/*.png'],
        matches: PLATFORM_MATCHES.map((m) => m.replace(/\/\*$/, '/*')),
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src *",
    },
  };
}

export function writeManifest(outFile, opts = {}) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(buildManifest(opts), null, 2));
}
