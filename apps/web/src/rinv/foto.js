/** Reduce una foto de celular antes de subirla (una de cámara pesa 3-6 MB y no hace falta: basta ver «el helado tenía cristales»). Devuelve base64 sin prefijo. */
export function reducirFoto(archivo, ladoMaximo = 900, calidad = 0.7) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(archivo); const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const e = Math.min(1, ladoMaximo / Math.max(img.width, img.height)); const c = document.createElement('canvas');
      c.width = Math.round(img.width * e); c.height = Math.round(img.height * e);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', calidad).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la foto')); };
    img.src = url;
  });
}
