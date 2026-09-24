/**
 * Dashboard Presupuesto Mantención Suministros 2027 · Planta Antofagasta
 * Web App de Google Apps Script: la página lee la base directamente desde Google Drive
 * con los permisos de quien la abre. No usa servicios externos.
 */
const FILE_ID = '1Lt-agN6d1NV099LCLnDFAdZ2fV5MpEwN'; // Presupuesto 2027-Afta.xlsm

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Presupuesto Suministros 2027')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // Permite insertar la página en Google Sites.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Inserta el contenido de otro archivo HTML del proyecto (librería de lectura de Excel). */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Devuelve la base en base64 para que la página la procese.
 * Funciona si el archivo es .xlsm/.xlsx en Drive o si se convierte a Hoja de cálculo de Google.
 */
function getBase() {
  const file = DriveApp.getFileById(FILE_ID);
  let bytes;
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    const url = 'https://docs.google.com/spreadsheets/d/' + FILE_ID + '/export?format=xlsx';
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
    bytes = res.getBlob().getBytes();
  } else {
    bytes = file.getBlob().getBytes();
  }
  return {
    b64: Utilities.base64Encode(bytes),
    name: file.getName(),
    modified: file.getLastUpdated().toISOString()
  };
}
