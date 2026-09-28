# PeloApp · prioridad de la primera versión

## Objetivo

Cuentas corrientes de tres kioscos escolares. Interfaz luminosa adaptable a celular y PC, usuarios con permisos por colegio, despliegue Cloudflare desde main. Stock, compras, documentos y contabilidad siguen en el proyecto; no son la prioridad del primer incremento.

## Implementado (piloto)

- Instalación inicial protegida por secreto; sesiones privadas y cuatro roles.
- Clientes por colegio: familia, alumno, personal u otro. Contacto/referencia libre.
- Productos comunes y precios con historial en base de datos.
- Consumos detallados o conceptos por importe; fecha de adquisición y precio original.
- Dos criterios por cuenta, elegidos al crearla: precio original o precio vigente al pagar.
- Comparación de pendiente original y actualizado.
- Vista previa obligatoria del cobro, pagos parciales FIFO y anticipos en pesos.
- Movimientos con fecha, responsable, aplicación a consumos y ajuste de precio.
- Operaciones financieras atómicas, bloqueo optimista e identificador para reintentos.
- Anulación de consumos y pagos (administradores) con motivo obligatorio. El movimiento no se borra: queda tachado y se registra una anulación. Un consumo solo se anula si no tiene pagos aplicados; un pago solo si es el más reciente de la cuenta (restituye los consumos y el anticipo previo).
- Modificación de consumos (administradores) con motivo: el original queda marcado como modificado y se registra el nuevo, con "antes" y "ahora". Mismas reglas que la anulación: sin pagos aplicados.
- Productos archivables (no se borran): dejan de ofrecerse al cargar consumos y aparecen en el filtro "Archivados"; las cuentas y el historial de precios no cambian. Un consumo existente conserva su producto archivado al modificarse.
- Proveedores: catálogo de proveedores, asignación individual o masiva de productos y pantalla de evolución de precios por proveedor (variación promedio, índice base 100, cambios por producto). Usa el precio general, no los precios por colegio.
- Auditoría (superadministrador: todo; administrador: movimientos de cuentas de sus colegios) con filtros por acción, persona y fechas.
- Fechas de consumo limitadas a 2020 hasta mañana; los colegios se validan contra la base de datos.
- Aplicación instalable (service worker mínimo sin caché de datos) y archivos estáticos revalidados en vez de descargados siempre.
- Usuarios activos/inactivos y colegios asignados; personalización por superadministrador.
- Resumen imprimible mediante navegador (también guardar PDF).

## Reglas monetarias

Importes en centavos enteros. Cada consumo conserva cantidad y precio unitario histórico. La fracción pendiente se representa mediante su importe base original, con precisión de un centavo. Al cobrar a precio vigente se valora esa fracción con el precio actual y se registra el ajuste respecto a la base cancelada. Los pagos parciales se prorratean con redondeo al centavo; la cancelación final absorbe el residuo. Un pago que no pueda representarse sin cerrar incorrectamente un residuo se rechaza con explicación.

No se revaloriza lo ya pagado. Los cargos sin producto conservan su importe. Un precio menor también disminuye la valoración pendiente: no se aplica silenciosamente una regla de “solo aumentos”. Un administrador puede modificar el criterio de la cuenta; el cambio queda registrado y no altera los cobros anteriores.

Al confirmar un cobro se emplea el precio revisado por el servidor; si la cuenta o el precio difieren de la vista previa se pide recalcular. El saldo a favor se aplica junto al siguiente cobro; un cobro de $0 permite aplicar solamente anticipos. No se aplica automáticamente al cargar consumos. Cada cuenta pertenece a un colegio; aún no hay cuentas familiares compartidas entre colegios.

## Pendientes para ampliar el piloto

- Alumnos vinculados estructurados, selección manual de ítems a cancelar y límites de crédito.
- Recuperación de acceso por correo (ya se puede restablecer contraseña desde Usuarios).
- Cuentas de proveedores separadas de clientes y circuito compra/remito/factura/pago.
- Exportaciones estructuradas, respaldos externos en Drive y reportes Sheets. No están conectados todavía.
- Stock por recuentos libres; salidas estimadas conciliadas con consumos registrados, mermas y transferencias.
- Depósito central, compras distribuidas y equivalencias caja/unidad.
- Compras, recepción y pago a proveedores; registro de movimientos de stock por colegio y prevención de doble recepción al vincular remitos/facturas.
- Lectura de archivos PDF; hoy se admiten fotos JPG, PNG y WebP.
- Apps Android/Windows/Linux y sincronización offline. Actualmente se requiere conexión; la pantalla mantiene los formularios al fallar una solicitud, pero recargar/cerrar pierde el borrador.
- Precios por colegio y personalización ampliada de comprobantes.

## Criterio de puesta en marcha

Probar con datos ficticios en dev. El SQL y las pruebas de integración locales no sustituyen una validación contra Cloudflare D1 real. Verificar despliegue, autenticación, cuotas y tiempos de ejecución en la cuenta del usuario. Antes de operar con dinero real completar las correcciones/anulaciones, recuperación de acceso, respaldo y ensayo de restauración.

## Ampliación 0.2.0

- Historial de precios con fecha, responsable, filtro por producto y paginación.
- Historial completo de movimientos paginado, incluidos cambios de ficha del cliente.
- Colegios: nombre editable, color e iniciales automáticas; logo propio mediante URL HTTPS.
- Cliente: nombre, tipo, contacto, notas y criterio de cobro editables por administrador de su colegio. El colegio de una cuenta existente se conserva.
- Usuarios: creación y edición de nombre, correo, rol, colegios, estado y contraseña. Los administradores solo gestionan operadores/consulta cuyos colegios están completamente dentro de sus asignaciones. Solo el superadministrador gestiona niveles administrativos. Las sesiones del usuario editado se cierran.
- Importación .xlsx: selección de hoja y columnas, primera fila como encabezado, vista previa, nombres repetidos y precios inválidos identificados. Hasta 300 filas y 3 MB por archivo.
- Coincidencias de productos por nombre normalizado. Se omiten por defecto; actualizar sus precios requiere marcar la opción. Productos nuevos y cambios se guardan atómicamente, generan historial y no se duplican al reintentar. No se importan stocks ni costos en este incremento.
- La migración 0002 conserva todos los usuarios, productos, consumos y pagos existentes.

## Ampliación 0.3.0 · Borradores desde fotos

- Superadministrador y administradores pueden cargar fotos JPG, PNG o WebP de hasta 3 MB desde celular o PC.
- Cloudflare Workers AI propone tipo, proveedor, número, fecha, total, observaciones y renglones del documento. La propuesta queda marcada para revisión; si el modelo no está disponible, se puede completar manualmente.
- El original se almacena en un bucket R2 privado. La app expone la imagen solo a usuarios autorizados.
- Los datos se pueden corregir, agregar/quitar renglones, y vincular documentos relacionados (por ejemplo, remito y factura). Se puede eliminar el borrador junto con su imagen.
- Esta etapa es una bandeja de revisión: guardar un borrador **no contabiliza compras, no cambia precios de venta ni mueve stock**. Esos movimientos requieren definir el circuito de compras y reparto entre colegios.
- La imagen se procesa con Cloudflare Workers AI para extraer datos. Evitar subir información que no corresponda a la gestión de estos kioscos.

## Ampliación 0.4.0 · Catálogo y cuentas por colegio

- Categorías compartidas, asignables a productos, renombrables y filtrables; búsqueda por producto o categoría.
- Carga rápida de consumo desde Cuentas corrientes y desde cada cliente, con búsqueda de cuenta y producto.
- Catálogo general compartido con precios diferenciales por colegio. Cada consumo conserva el precio aplicado; la deuda pendiente se compara contra el precio vigente de su colegio.
- Un cliente puede tener cuenta en varios colegios: se comparte su ficha, pero cada colegio conserva una cuenta, saldo, consumos, pagos y criterio de cobro independientes.
- La migración 0004 agrega los vínculos y precios sin reescribir consumos, pagos ni el historial general existente.
