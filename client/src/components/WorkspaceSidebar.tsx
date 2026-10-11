import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';

export function WorkspaceSidebar({children}:{children:ReactNode}) {
  const [collapsed,setCollapsed]=useState(false), [open,setOpen]=useState(false);
  const {pathname}=useLocation();
  const marker=useRef<HTMLDivElement>(null);
  useEffect(()=>{setOpen(false);},[pathname]);
  useEffect(()=>{const layout=marker.current?.closest('.dashboard-layout');layout?.classList.toggle('sidebar-collapsed',collapsed);return()=>{layout?.classList.remove('sidebar-collapsed');};},[collapsed]);
  return <div className="sidebar-container" ref={marker}>
    <button className="sidebar-collapse icon-button" aria-label={collapsed?'Expand sidebar':'Collapse sidebar'} aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}>{collapsed?<PanelLeftOpen/>:<PanelLeftClose/>}</button>
    <aside className="account-sidebar desktop-sidebar" hidden={collapsed}>{children}</aside>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><button className="btn btn-secondary sidebar-mobile-trigger"><Menu size={18}/>Workspace menu</button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="sidebar-overlay"/><Dialog.Content className="sidebar-drawer">
        <div className="feature-toolbar"><Dialog.Title>Workspace menu</Dialog.Title><Dialog.Close asChild><button className="icon-button" aria-label="Close workspace menu"><X/></button></Dialog.Close></div>
        <Dialog.Description className="small muted">Your permitted modules and account settings.</Dialog.Description>
        <aside className="account-sidebar">{children}</aside>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div>;
}
