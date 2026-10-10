import {createContext,useContext,useState,useEffect,type ReactNode} from 'react';
import {toast} from 'sonner';
import type {Product} from '../types';
export interface CartItem {product:Product;quantity:number}
type Cart={items:CartItem[];count:number;subtotal:number;add:(p:Product,q?:number)=>void;update:(id:string,q:number)=>void;remove:(id:string)=>void;clear:()=>void};
const Context=createContext<Cart|null>(null);
export function CartProvider({children}:{children:ReactNode}){
 const [items,setItems]=useState<CartItem[]>(()=>{try{const stored=JSON.parse(localStorage.getItem('pawsconnect-cart-v1')||'[]');return Array.isArray(stored)?stored.filter((x:any)=>x.product?.id&&Number.isInteger(x.quantity)&&x.quantity>0):[];}catch{return [];}});
 useEffect(()=>{localStorage.setItem('pawsconnect-cart-v1',JSON.stringify(items));},[items]);
 const value:Cart={items,count:items.reduce((n,i)=>n+i.quantity,0),subtotal:items.reduce((n,i)=>n+i.quantity*i.product.price_centavos,0),add(product,quantity=1){const available=product.stock_quantity-(product.reserved_quantity||0);if(available<1){toast.error('This item is out of stock.');return;}setItems(previous=>{const existing=previous.find(i=>i.product.id===product.id);return existing?previous.map(i=>i.product.id===product.id?{product,quantity:Math.min(available,i.quantity+quantity)}:i):[...previous,{product,quantity:Math.min(available,quantity)}];});toast.success(`${product.name} added to your cart`);},update(id,quantity){setItems(previous=>previous.map(i=>i.product.id===id?{...i,quantity:Math.max(1,Math.min(i.product.stock_quantity-(i.product.reserved_quantity||0),quantity))}:i));},remove(id){setItems(previous=>previous.filter(i=>i.product.id!==id));},clear(){setItems([]);}};
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useCart(){const context=useContext(Context);if(!context)throw new Error('CartProvider missing');return context;}
