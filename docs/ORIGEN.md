# Origen — frutas, jugos y verduras (estilo bar de jugos premium)

Origen es el negocio nuevo, por eso es el que **estrena** el motor común. Está pensado como una marca de
jugos prensados en frío, smoothies, bowls y fruta/verdura, con servicio de mostrador rápido.

## Qué ya funciona (probado)

| Área | Detalle |
|---|---|
| **Caja táctil** | Rejilla de productos por categoría con color, buscador, lector de código de barras, orden con nombre para llamar, "aquí / para llevar", cliente (consumidor final o con RTN) |
| **Personalización** | Grupos de opciones con mínimos y máximos (Tamaño obligatorio, hasta 3 Boosters, Leche…), precio extra por opción, nota para cocina |
| **Venta por peso** | Fruta y verdura por kg/lb con teclado numérico (cantidades decimales, exentas de ISV) |
| **Cobro** | Efectivo con cambio, tarjeta, transferencia y **pagos mixtos**; billetes rápidos; referencia de autorización |
| **Fiscal** | Factura con correlativo atómico, modo borrador hasta cargar el CAI, ISV 15 %/18 %/exento, ticket térmico 80 mm |
| **Turnos de caja** | Apertura con fondo, movimientos (entradas/salidas), cierre con cuadre automático; el cajero no ve el "esperado" antes de contar (cierre ciego) |
| **Órdenes abiertas** | Guardar, retomar, editar y cobrar después |
| **Cocina (KDS)** | Pantalla con Pendiente → Preparando → Listo → Entregado, tiempos en rojo si tardan |
| **Inventario con recetas** | Cada producto descuenta sus insumos (con % de merma de cáscara/semilla) y lo que consumen los extras, FEFO por vencimiento, mermas con motivo, conteos, traslados |
| **Costo y margen reales** | El costo de la receta se congela en cada venta; reporte de margen por producto; "Marcar agotados" en un toque |
| **Dirección** | Origen aparece en el consolidado del grupo junto a las demás empresas |

## Demo cargada

`npm run seed:origen` carga 5 jugos prensados, 2 smoothies, 1 bowl, 1 shot, mango y banano por kg, con
recetas, 24 insumos y existencias iniciales. **Todos los precios y costos son de ejemplo** — ya muestran
algo útil: p. ej. "Mango por kg" sale con 33 % de margen y "Green Detox" con 47 %, señal de revisar precio o
rendimiento.

## Lo que falta para un Origen completo (por prioridad)

1. **Operación diaria**: modo sin conexión con cola de ventas · bottom-sheet de la orden en celular ·
   impresión directa a térmica (hoy usa el diálogo del navegador).
2. **Producción de jugos**: lotes de producción (prensar N botellas de una vez, rendimiento real vs receta,
   etiqueta con fecha de vencimiento y QR).
3. **Pedidos por adelantado**: recoger/delivery con hora, **programas/cleanses** (paquetes de 3–6 jugos
   por día, prepagados) y suscripciones semanales — es el producto estrella de este formato de negocio.
4. **Lealtad y clientes**: puntos o "jugo número 10 gratis", monedero, cumpleaños; historial por cliente
   (la base ya cruza clientes entre empresas).
5. **Compras**: sugerido de compra por consumo real de la semana y días de inventario; órdenes a proveedor.
6. **Pedidos en línea / WhatsApp**: menú público y pago (se evalúa según costo/beneficio).
7. **Fotos y descripciones** de producto, alérgenos y calorías en el menú.
8. **Mermas inteligentes**: alerta de maduración (fruta que pasa de X días), "no desperdicies": promoción
   automática de lo que vence mañana.
