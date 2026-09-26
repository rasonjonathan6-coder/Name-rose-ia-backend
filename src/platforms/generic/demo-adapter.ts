import type { PlatformId } from '@/shared/types';
import { GenericChatAdapter } from './adapter';
import { DEMO_CONFIG } from './config';
import { documentUrl } from '../types';

/**
 * Adapter for the local demo harness (demo/demo.html) and for automated tests.
 *
 * The demo page uses explicit `data-*` hooks so the E2E flow (detection →
 * generation → insertion → auto-send) is deterministic and does not depend on
 * the heuristics being lucky.
 */
export class DemoAdapter extends GenericChatAdapter {
  override readonly id: PlatformId = 'demo';
  override readonly label = 'Local demo';

  constructor() {
    super(DEMO_CONFIG);
  }

  override matches(url: URL): boolean {
    if (!/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return false;
    // Only claim localhost pages that actually expose the demo hooks.
    return true;
  }

  override score(doc: Document): number {
    if (!this.matches(documentUrl(doc))) return 0;
    if (doc.querySelector('#demo-messages') && doc.querySelector('#demo-input')) return 1;
    return 0.2;
  }
}

