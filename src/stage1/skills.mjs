import { z } from 'zod';
import { fail } from '../safety.mjs';

export const skillSelection = z.object({ name: z.string().min(1).max(160),
  path: z.string().min(1).max(4096).refine(path => path.startsWith('/')) }).strict();
const metadata = skillSelection.extend({ enabled: z.boolean() }).passthrough();

export async function readSkills(native, cwd, forceReload = false) {
  let response;
  try { response = await native.request('skills/list', { cwds: [cwd], forceReload }); }
  catch (e) { if (['UNSUPPORTED_RPC', 'BACKEND_REJECTED'].includes(e.code)) fail('SKILL_CATALOG_UNAVAILABLE'); throw e; }
  if (!Array.isArray(response?.data)) fail('SKILL_CATALOG_UNAVAILABLE');
  const entries = response.data.filter(entry => entry?.cwd === cwd);
  if (entries?.length !== 1 || !Array.isArray(entries[0].skills) || !Array.isArray(entries[0].errors)) fail('SKILL_CATALOG_UNAVAILABLE');
  const skills = entries[0].skills.map(skill => metadata.safeParse(skill));
  if (skills.some(skill => !skill.success)) fail('SKILL_CATALOG_UNAVAILABLE');
  return { skills: skills.map(skill => skill.data), errorCount: entries[0].errors.length };
}

export async function resolveSkills(native, cwd, selections = []) {
  if (!selections.length) return [];
  if (new Set(selections.map(skill => JSON.stringify([skill.name, skill.path]))).size !== selections.length) fail('DUPLICATE_SKILL');
  const catalog = await readSkills(native, cwd, true);
  return selections.map(selection => {
    const matches = catalog.skills.filter(skill => skill.name === selection.name && skill.path === selection.path);
    if (!matches.length) fail('SKILL_NOT_FOUND');
    if (matches.length !== 1) fail('SKILL_AMBIGUOUS');
    if (!matches[0].enabled) fail('SKILL_DISABLED');
    return { type: 'skill', name: selection.name, path: selection.path };
  });
}
