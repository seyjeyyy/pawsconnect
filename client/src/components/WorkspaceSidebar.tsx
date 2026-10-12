import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, PanelLeftClose, PanelLeftOpen, PawPrint, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAuth } from '../contexts/AuthContext';
import { homePath, roleTitle } from '../lib/roles';

// True inside the desktop sidebar while it is collapsed to icons. Menus read it to drop their labels.
const RailContext = createContext(false);
export const useSidebarRail = () => useContext(RailContext);

const RAIL_KEY = 'pawsconnect_sidebar_rail';
const storedRail = () => { try { return localStorage.getItem(RAIL_KEY) === 'true'; } catch { return false; } };

/**
 * The workspace menu. On desktop it is a fixed column down the left edge that
 * collapses to an icon rail (remembered between visits); on smaller screens it
 * opens as a drawer from the "Menu" button.
 */
export function WorkspaceSidebar({children}:{children:ReactNode}) {
  const [rail,setRail]=useState(storedRail), [open,setOpen]=useState(false);
  const {pathname}=useLocation();
  const {roles,permissions}=useAuth();
  useEffect(()=>{setOpen(false);},[pathname]);
  useEffect(()=>{
    const shell=document.querySelector('.workspace-shell');
    shell?.classList.toggle('sidebar-rail',rail);
    try { localStorage.setItem(RAIL_KEY,String(rail)); } catch { /* private mode: the choice lasts for this visit */ }
    return()=>{shell?.classList.remove('sidebar-rail');};
  },[rail]);
  return <div className="sidebar-container">
    <div className="sidebar-fixed">
      <div className="sidebar-top">
        <Link className="sidebar-brand" to={homePath(roles,permissions)} aria-label="PawsConnect home"><span className="brand-mark"><PawPrint fill="currentColor" size={20}/></span><span>PawsConnect<small>{roleTitle(roles)}</small></span></Link>
        <button className="sidebar-collapse icon-button" aria-label={rail?'Expand sidebar':'Collapse sidebar'} title={rail?'Expand sidebar':'Collapse sidebar'} aria-expanded={!rail} onClick={()=>setRail(!rail)}>{rail?<PanelLeftOpen size={20}/>:<PanelLeftClose size={20}/>}</button>
      </div>
      <RailContext.Provider value={rail}><aside className="account-sidebar desktop-sidebar">{children}</aside></RailContext.Provider>
    </div>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><button className="btn btn-secondary sidebar-mobile-trigger"><Menu size={18}/>Workspace menu</button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="sidebar-overlay"/><Dialog.Content className="sidebar-drawer">
        <div className="feature-toolbar"><Dialog.Title>Workspace menu</Dialog.Title><Dialog.Close asChild><button className="icon-button" aria-label="Close workspace menu"><X/></button></Dialog.Close></div>
        <Dialog.Description className="sr-only">Pages you can open with this account.</Dialog.Description>
        <aside className="account-sidebar">{children}</aside>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div>;
}
