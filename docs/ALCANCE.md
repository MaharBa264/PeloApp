# PeloApp · prioridad de la primera versión

## Objetivo

Cuentas corrientes de tres kioscos escolares. Interfaz luminosa adaptable a celular y PC, usuarios con permisos por colegio, despliegue Cloudflare desde main. Stock, compras, documentos y contabilidad siguen en el proyecto; no son la prioridad del primer incremento.

## Implementado en 0.1.0 (piloto)

- Instalación inicial protegida por secreto; sesiones privadas y cuatro roles.
- Clientes por colegio: familia, alumno, personal u otro. Contacto/referencia libre.
- Productos comunes y precios con historial en base de datos.
- Consumos detallados o conceptos por importe; fecha de adquisición y precio original.
- Dos criterios por cuenta, elegidos al crearla: precio original o precio vigente al pagar.
- Comparación de pendiente original y actualizado.
- Vista previa obligatoria del cobro, pagos parciales FIFO y anticipos en pesos.
- Movimientos con fecha, responsable, aplicación a consumos y ajuste de precio.
- Operaciones financieras atómicas, bloqueo optimista e identificador para reintentos.
- Usuarios activos/inactivos y colegios asignados; personalización por superadministrador.
- Resumen imprimible mediante navegador (también guardar PDF).

## Reglas monetarias

Importes en centavos enteros. Cada consumo conserva cantidad y precio unitario histórico. La fracción pendiente se representa mediante su importe base original, con precisión de un centavo. Al cobrar a precio vigente se valora esa fracción con el precio actual y se registra el ajuste respecto a la base cancelada. Los pagos parciales se prorratean con redondeo al centavo; la cancelación final absorbe el residuo. Un pago que no pueda representarse sin cerrar incorrectamente un residuo se rechaza con explicación.

No se revaloriza lo ya pagado. Los cargos sin producto conservan su importe. Un precio menor también disminuye la valoración pendiente: no se aplica silenciosamente una regla de “solo aumentos”. El criterio de la cuenta no se modifica en esta versión.

Al confirmar un cobro se emplea el precio revisado por el servidor; si la cuenta o el precio difieren de la vista previa se pide recalcular. El saldo a favor se aplica junto al siguiente cobro; un cobro de $0 permite aplicar solamente anticipos. No se aplica automáticamente al cargar consumos. Cada cuenta pertenece a un colegio; aún no hay cuentas familiares compartidas entre colegios.

## Pendientes para ampliar el piloto

- Edición de clientes, alumnos vinculados estructurados, selección manual de ítems a cancelar y límites de crédito.
- Reversión/anulación formal de movimientos con motivo; no editar saldos directamente para corregir errores.
- Cambio de contraseña, recuperación de acceso y edición de asignaciones/roles existentes.
- Cuentas de proveedores separadas de clientes y circuito compra/remito/factura/pago.
- Exportaciones estructuradas, respaldos externos en Drive y reportes Sheets. No están conectados todavía.
- Stock por recuentos libres; salidas estimadas conciliadas con consumos registrados, mermas y transferencias.
- Depósito central, compras distribuidas y equivalencias caja/unidad.
- Lectura de fotos/PDF con revisión y prevención de doble recepción remito/factura.
- Apps Android/Windows/Linux y sincronización offline. Actualmente se requiere conexión; la pantalla mantiene los formularios al fallar una solicitud, pero recargar/cerrar pierde el borrador.
- Precios por colegio y personalización ampliada de comprobantes.

## Criterio de puesta en marcha

Probar con datos ficticios en dev. El SQL y las pruebas de integración locales no sustituyen una validación contra Cloudflare D1 real. Verificar despliegue, autenticación, cuotas y tiempos de ejecución en la cuenta del usuario. Antes de operar con dinero real completar las correcciones/anulaciones, recuperación de acceso, respaldo y ensayo de restauración.
