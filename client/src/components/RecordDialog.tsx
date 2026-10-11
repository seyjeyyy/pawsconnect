import {cloneElement, type ReactElement, type ReactNode} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
/** Shared focus trap, Escape dismissal and focus restoration for record forms. */
export function RecordDialog({children,onClose,label}:{children:ReactElement<{children?:ReactNode}>;onClose:()=>void;label:string}){
 const content=cloneElement(children,{},<><Dialog.Title className="sr-only">{label}</Dialog.Title>{children.props.children}</>);
 return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal><Dialog.Overlay className="modal-backdrop"><Dialog.Content asChild aria-describedby={undefined} aria-label={label}>{content}</Dialog.Content></Dialog.Overlay></Dialog.Portal></Dialog.Root>;
}
