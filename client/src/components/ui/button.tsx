import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
const buttonVariants = cva('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:pointer-events-none disabled:opacity-50', {variants: {variant: {default: 'bg-orange-500 text-white hover:bg-orange-600', secondary: 'bg-white text-slate-800 border border-stone-200 hover:bg-stone-50', ghost: 'hover:bg-stone-100'}, size: {default:'h-11 px-5', sm:'h-9 px-3', icon:'h-11 w-11'}}, defaultVariants:{variant:'default',size:'default'}});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {asChild?: boolean}
export function Button({className, variant, size, asChild = false, ...props}:ButtonProps) {const Comp=asChild?Slot:'button'; return <Comp data-slot="button" className={cn(buttonVariants({variant,size,className}))} {...props}/>;}
export {buttonVariants};
