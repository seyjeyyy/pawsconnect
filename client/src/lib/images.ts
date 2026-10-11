/** Resize public listing uploads before transfer. Evidence/documents retain original bytes. */
export async function optimizeListingImage(file: File): Promise<File> {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || typeof createImageBitmap !== 'function') return file;
  const bitmap=await createImageBitmap(file);
  try {
    const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext('2d');if(!context)return file;
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',.82));
    return blob && blob.size<file.size ? new File([blob],file.name.replace(/\.[^.]+$/,'')+'.webp',{type:blob.type}) : file;
  } finally { bitmap.close(); }
}
