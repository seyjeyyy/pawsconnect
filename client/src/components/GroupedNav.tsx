import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronDown, type LucideIcon } from 'lucide-react';

export type NavItem = { key: string; label: string; icon: LucideIcon; to: string; group?: string };

// Short menus read fine as a plain list; grouping only helps once there is a lot to scan.
const GROUP_FROM = 7;

/**
 * Sidebar menu. Items that share a `group` are shown under a collapsible
 * heading; items without one stay at the top level. The group holding the
 * current page is always open, and the others remember how the user left them.
 */
export function GroupedNav({ label, items, current }: { label: string; items: NavItem[]; current: string }) {
  const activeGroup = items.find(item => item.key === current)?.group;
  const [open, setOpen] = useState<Set<string>>(() => new Set(activeGroup ? [activeGroup] : []));
  useEffect(() => {
    if (activeGroup) setOpen(previous => previous.has(activeGroup) ? previous : new Set(previous).add(activeGroup));
  }, [activeGroup]);

  const link = ({ key, label: text, icon: Icon, to }: NavItem) =>
    <NavLink key={key} to={to} className={key === current ? 'active' : ''} aria-current={key === current ? 'page' : undefined}><Icon size={17} />{text}</NavLink>;

  if (items.length < GROUP_FROM) return <nav aria-label={label}>{items.map(link)}</nav>;

  // Keep the order the items were given in: a group appears where its first item does.
  const sections: ({ item: NavItem } | { group: string; items: NavItem[] })[] = [];
  for (const item of items) {
    if (!item.group) { sections.push({ item }); continue; }
    const existing = sections.find(section => 'group' in section && section.group === item.group);
    if (existing && 'group' in existing) existing.items.push(item);
    else sections.push({ group: item.group, items: [item] });
  }

  return <nav aria-label={label} className="nav-grouped">
    {sections.map(section => 'item' in section ? link(section.item) :
      <details key={section.group} className="nav-group" open={open.has(section.group)}
        onToggle={event => { const isOpen = event.currentTarget.open; setOpen(previous => { if (previous.has(section.group) === isOpen) return previous; const next = new Set(previous); if (isOpen) next.add(section.group); else next.delete(section.group); return next; }); }}>
        <summary><span>{section.group}</span><small>{section.items.length}</small><ChevronDown size={15} /></summary>
        {section.items.map(link)}
      </details>)}
  </nav>;
}
