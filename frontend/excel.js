import readExcelFile from 'read-excel-file/browser';
export async function readWorkbook(file){
  if(!file || !file.name.toLowerCase().endsWith('.xlsx'))throw new Error('Elegí un archivo Excel .xlsx. Si es .xls, guardalo como .xlsx desde Excel.');
  if(file.size>3*1024*1024)throw new Error('El archivo debe pesar menos de 3 MB.');
  const sheets=await readExcelFile(file);
  if(!sheets.length)throw new Error('El archivo no contiene hojas.');
  return sheets;
}
import writeExcelFile from 'write-excel-file/browser';
export async function saveTable(fileName,header,rows,widths=[]){
  const data=[header.map(value=>({value,fontWeight:'bold'})),...rows];
  const blob=await writeExcelFile(data,{columns:widths.map(width=>({width}))}).toBlob();
  const url=URL.createObjectURL(blob),link=Object.assign(document.createElement('a'),{href:url,download:fileName});
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
