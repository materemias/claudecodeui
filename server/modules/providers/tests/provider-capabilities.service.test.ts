import assert from 'node:assert/strict';
import test from 'node:test';

import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';

test('advertises provider grouping for catalogs with provider-prefixed selectors', () => {
  assert.equal(
    providerCapabilitiesService.getProviderCapabilities('opencode').groupsModelsByProvider,
    true,
  );
  assert.equal(
    providerCapabilitiesService.getProviderCapabilities('claude').groupsModelsByProvider,
    false,
  );
  assert.equal(
    providerCapabilitiesService.getProviderCapabilities('cursor').groupsModelsByProvider,
    false,
  );
  assert.equal(
    providerCapabilitiesService.getProviderCapabilities('codex').groupsModelsByProvider,
    false,
  );
});
