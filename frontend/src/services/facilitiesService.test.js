import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/index.js';

vi.mock('./apiClient', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

const api = (await import('./apiClient')).default;
const {
  facilityKinds,
  ruleTypes,
  addonsApi,
  facilitiesApi,
  facilityCategoriesApi,
  facilityTypesApi,
  maintenanceBlocksApi,
  pricingRulesApi,
} = await import('./facilitiesService.js');
const { clubsApi, } = await import('./clubsService.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('endpoint paths', () => {
  it.each([
    [() => clubsApi.list(), '/clubs/'],
    [() => facilitiesApi.list(), '/facilities/'],
    [() => facilityCategoriesApi.list(), '/facilities/categories/'],
    [() => facilityTypesApi.list(), '/facilities/types/'],
    [() => addonsApi.list(), '/facilities/addons/'],
    [() => pricingRulesApi.list(), '/facilities/pricing-rules/'],
    [() => maintenanceBlocksApi.list(), '/facilities/maintenance-blocks/'],
  ])('lists from the club/facility REST namespace', async (call, path) => {
    await call();
    expect(api.get).toHaveBeenCalledWith(path, { params: undefined });
  });

  it('never targets a legacy route', async () => {
    await facilityCategoriesApi.list();
    await facilityTypesApi.list();
    const paths = api.get.mock.calls.map(([p]) => p);
    for (const p of paths) {
      expect(p).not.toMatch(/services|vehicles|jobcards|bays|sites/);   // legacy-term-guard: allow
    }
  });
});

describe('vocabulary', () => {
  it('offers only facility kinds', () => {
    expect(facilityKinds(t).map((k) => k.value)).toEqual([
      'outdoor_court', 'indoor_court', 'pitch', 'aquatic',
      'hall', 'meeting_room', 'other',
    ]);
  });

  it('has no vehicle-type pricing rule', () => {   // legacy-term-guard: allow
    const values = ruleTypes(t).map((r) => r.value);
    expect(values).not.toContain('vehicle_type');
    expect(values).toContain('club');
  });
});

describe('multipart handling', () => {
  it('sends FormData payloads as multipart', async () => {
    const fd = new FormData();
    await facilityCategoriesApi.create(fd);
    expect(api.post).toHaveBeenCalledWith('/facilities/categories/', fd,
      { headers: { 'Content-Type': 'multipart/form-data' } });
  });

  it('sends plain objects as JSON', async () => {
    await facilityCategoriesApi.create({ name: 'Aquatics' });
    expect(api.post).toHaveBeenCalledWith('/facilities/categories/',
      { name: 'Aquatics' }, undefined);
  });
});
