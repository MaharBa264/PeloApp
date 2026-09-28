import {assert,cents} from './domain.js';
export const nameKey = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('es');
export function importPrice(value) {
  if(typeof value === 'number') {assert(Number.isFinite(value) && value>0 && value<100000000,'Precio inválido.');return cents(value.toFixed(2));}
  let s=String(value??'').trim().replace(/^(ARS|\$)\s*/i,'').replace(/\s/g,'');
  // Text values use Argentine notation. Numeric Excel cells have no locale ambiguity.
  if(s.includes(',')){assert(/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(s),'Precio de texto inválido. Usá formato argentino.');s=s.replaceAll('.','').replace(',','.');}
  else if(/^\d{1,3}(\.\d{3})+$/.test(s))s=s.replaceAll('.','');
  const price=cents(s);assert(price>0,'El precio debe ser mayor a cero.');return price;
}
export function planImport(input,products,updateExisting=false){
  assert(Array.isArray(input)&&input.length>0&&input.length<=300,'Importá entre 1 y 300 filas por archivo.');
  const seen=new Set(),errors=[],items=[];
  input.forEach((r,i)=>{const row=Number.isInteger(r.source_row)&&r.source_row>=2?r.source_row:i+2;try{
    const name=String(r.name??'').trim().replace(/\s+/g,' '),key=nameKey(name);
    assert(name&&name.length<=160,'Nombre vacío o demasiado largo.');assert(!seen.has(key),'Nombre repetido dentro del archivo.');seen.add(key);
    const price=importPrice(r.price),matches=products.filter(p=>nameKey(p.name)===key);assert(matches.length<=1,'Hay varios productos con ese nombre en el catálogo.');
    const old=matches[0],action=old?(updateExisting&&old.price!==price?'update':'skip'):'create';
    items.push({row,name,price,action,id:old?.id||null,old_price:old?.price??null,version:old?.version??null});
  }catch(e){errors.push({row,error:e.message});}});
  return {items,errors,create:items.filter(x=>x.action==='create').length,update:items.filter(x=>x.action==='update').length,skip:items.filter(x=>x.action==='skip').length};
}
