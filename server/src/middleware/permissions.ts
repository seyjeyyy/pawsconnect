// Module checks complement (never replace) legacy role, assignment and SQL checks.
export function workspacePermissions(method: string, path: string): string[] {
  const [, resource, id] = path.split('/');
  if (resource === 'overview') return ['animals.view','animals.manage','animals.health','adoptions.review','adoptions.decide','rescue.manage','rescue.assigned','transport.manage','transport.assigned','store.manage','volunteers.manage','donations.view','donations.manage','finance.manage','contacts.manage','zones.view','zones.manage','reports.export'];
  if (resource === 'analytics') return ['finance.manage'];
  if (resource === 'lookups') return ({pets:['animals.view','animals.health','adoptions.review'],categories:['store.manage'],drivers:['transport.manage'],vehicles:['transport.manage'],rescuers:['rescue.manage']} as Record<string,string[]>)[id] ?? [];
  if (['pets','intake'].includes(resource)) return method === 'GET' ? ['animals.view'] : path.endsWith('/behavior') ? ['animals.health','animals.manage'] : ['animals.manage'];
  if (resource === 'health') return ['animals.health'];
  if (resource === 'adoptions') return ['adoptions.review'];
  if (resource === 'rescue') return ['rescue.manage','rescue.assigned'];
  if (['transport','alternatives','vehicles','drivers'].includes(resource)) return resource === 'transport' ? ['transport.manage','transport.assigned'] : ['transport.manage'];
  if (['products','categories','orders','inventory','reviews','shipments'].includes(resource)) return ['store.manage'];
  if (['payments','refunds','expenses'].includes(resource)) return ['finance.manage'];
  if (resource === 'donations') return method === 'GET' ? ['donations.view'] : ['donations.manage'];
  if (resource === 'volunteers') return ['volunteers.manage'];
  if (resource === 'transport-settings') return ['transport.manage'];
  if (resource === 'zones') return method==='GET'?['zones.view','zones.manage']:['zones.manage'];
  if (resource === 'contact_messages') return ['contacts.manage'];
  return [];
}
