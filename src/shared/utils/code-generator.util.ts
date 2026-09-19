/**
 * Genera un código numérico aleatorio de la cantidad de dígitos especificada.
 * @param digits - Cantidad de dígitos del código (debe ser >= 1).
 * @returns String con exactamente `digits` dígitos, incluyendo ceros a la izquierda.
 */
export function generateCode(digits: number): string {
    const min = Math.pow(10, digits - 1);
    const max = Math.pow(10, digits) - 1;
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
}
