/**
 * Dashboard Presupuesto Mantención Suministros 2027 · Planta Antofagasta
 * Web App de Google Apps Script: lee la base directamente desde Google Drive
 * con los permisos de quien abre la página.
 */
const FILE_ID = '1Lt-agN6d1NV099LCLnDFAdZ2fV5MpEwN'; // Presupuesto 2027-Afta.xlsm

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Presupuesto Suministros 2027')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // permite insertarlo en Google Sites
}

/** Devuelve el Excel en base64 para que la página lo procese. */
function getBase() {
  const file = DriveApp.getFileById(FILE_ID);
  let bytes;
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    // Si algún día la base se convierte a Hoja de cálculo de Google, se exporta como .xlsx
    const url = 'https://docs.google.com/spreadsheets/d/' + FILE_ID + '/export?format=xlsx';
    bytes = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().getBytes();
  } else {
    bytes = file.getBlob().getBytes();
  }
  return { b64: Utilities.base64Encode(bytes), name: file.getName(), modified: file.getLastUpdated().toISOString() };
}

/** Ejecuta esta función una vez desde el editor para autorizar el acceso a Drive. */
function probar() {
  const r = getBase();
  Logger.log('OK: ' + r.name + ' · ' + Math.round(r.b64.length * 0.75 / 1024) + ' KB');
}
