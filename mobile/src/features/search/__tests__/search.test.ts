import { describe, expect, it } from '@jest/globals';

import { harness } from '../../../data/__tests__/helpers';
import { hitCount, searchAll } from '../search';

describe('Search (S5-SEARCH)', () => {
  it('empty query → nothing', () => {
    const { get } = harness(1);
    expect(hitCount(searchAll(get(), 'super', '  '))).toBe(0);
  });

  it('super: projects, DevOps by project name (no "Client · Project"), companies, people', () => {
    const { get } = harness(1);
    const r = searchAll(get(), 'super', 'daco');
    expect(r.projects.map((p) => p.id)).toEqual(['dacop']);
    expect(r.devops.map((d) => [d.key, d.name])).toEqual([['OPS-101', 'Daco platform']]);
    expect(r.companies.map((c) => c.id)).toEqual(['daco']);
    expect(r.people.map((p) => p.name)).toEqual(['Ingrid Solberg', 'Lars Moen']);
  });

  it('tickets by key or title; pages by label', () => {
    const { get } = harness(1);
    expect(searchAll(get(), 'super', 'pmt-1').tickets.map((t) => t.key)).toContain('PMT-11');
    expect(searchAll(get(), 'super', 'bankid').tickets.map((t) => t.key)).toEqual(['PMT-10']);
    expect(searchAll(get(), 'super', 'timesheet').pages.map((p) => p.key)).toEqual(['emp', 'time']);
  });

  it('filters groups by page access', () => {
    const { get, as } = harness(3);
    const dev = searchAll(get(), 'dev', 'daco');
    expect(dev.people).toEqual([]);
    expect(dev.devops).toEqual([]);
    expect(dev.companies.map((c) => c.id)).toEqual(['daco']);
    as(6);
    const devops = searchAll(get(), 'devops', 'a');
    expect(devops.tickets).toEqual([]);
    expect(devops.projects).toEqual([]);
    expect(devops.companies).toEqual([]);
    expect(devops.devops.length).toBeGreaterThan(0);
  });

  it('caps groups at 6 rows (5 pages)', () => {
    const { get } = harness(1);
    const r = searchAll(get(), 'super', 'e');
    expect(r.tickets.length).toBeLessThanOrEqual(6);
    expect(r.pages.length).toBeLessThanOrEqual(5);
  });
});
