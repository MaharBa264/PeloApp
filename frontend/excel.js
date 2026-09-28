import readExcelFile from 'read-excel-file/browser';
export async function readWorkbook(file){
  if(!file || !file.name.toLowerCase().endsWith('.xlsx'))throw new Error('Elegí un archivo Excel .xlsx. Si es .xls, guardalo como .xlsx desde Excel.');
  if(file.size>3*1024*1024)throw new Error('El archivo debe pesar menos de 3 MB.');
  const sheets=await readExcelFile(file);
  if(!sheets.length)throw new Error('El archivo no contiene hojas.');
  return sheets;
}
