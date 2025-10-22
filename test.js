
function log(message, level = 'INFO') {
  const ts = new Date().toISOString();
  const color = {
    INFO: '\x1b[36m',
    WARN: '\x1b[33m',
    ERROR: '\x1b[31m',
    SUCCESS: '\x1b[32m',
  }[level] || '\x1b[0m';
  const consoleLine = `${color}[${ts}] [${level}]\x1b[0m ${message}`;
  const fileLine = `[${ts}] [${level}] ${message}`;
  console.log(consoleLine);
  appendLogFile(fileLine);
}

function a (){
    log('[ERROR] Không thể mở vị thế BAS: risk control', 'ERROR')
    
}

a()