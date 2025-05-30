// server-ws.js
require('dotenv').config();
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

const { WS_PORT } = process.env;

const wss = new WebSocket.Server({ port: WS_PORT });
const db = new sqlite3.Database('./db.sqlite');

function broadcast(tipo, hora, estado, nombre = '') {
  const mensaje = JSON.stringify({ tipo, hora, estado, nombre });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(mensaje);
    }
  });
}

function limpiarExpiradas(callback) {
  const ahora = Date.now();
  db.run(`UPDATE horas SET estado='disponible', expiracion=NULL 
          WHERE estado='pre-reservado' AND expiracion < ?`, [ahora], () => {
    db.all(`SELECT hora FROM horas WHERE estado = 'disponible' AND expiracion IS NULL`, (err, filas) => {
      filas?.forEach(fila => {
        broadcast('estado_actualizado', fila.hora, 'disponible');
      });
      callback?.();
    });
  });
}

function enviarEstadoInicial(ws) {
  limpiarExpiradas(() => {
    db.all(`SELECT hora, estado FROM horas`, (err, horas) => {
      ws.send(JSON.stringify({ tipo: 'estado_inicial', horas }));
    });
  });
}

function manejarMensaje(ws, mensaje) {
  let data;
  try {
    data = JSON.parse(mensaje);
  } catch {
    return ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Formato inválido' }));
  }

  const { tipo, hora, nombre } = data;

  if (tipo === 'pre-reservar') {
    const expiracion = Date.now() + 30000;
    limpiarExpiradas(() => {
      db.get(`SELECT estado FROM horas WHERE hora = ?`, [hora], (err, row) => {
        if (row?.estado === 'disponible') {
          db.run(`UPDATE horas SET estado='pre-reservado', expiracion=? WHERE hora=?`,
            [expiracion, hora], () => {
              broadcast('estado_actualizado', hora, 'pre-reservado');
            });
        } else {
          ws.send(JSON.stringify({ tipo: 'error', mensaje: 'No disponible para pre-reserva' }));
        }
      });
    });
  } else if (tipo === 'cancelar-pre-reserva') {
    db.run(`UPDATE horas SET estado='disponible', expiracion=NULL WHERE hora=? AND estado='pre-reservado'`,
      [hora], () => {
        broadcast('estado_actualizado', hora, 'disponible');
      });
  } else if (tipo === 'reservar') {
    if (!nombre) return ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Nombre requerido' }));

    db.get(`SELECT estado FROM horas WHERE hora=?`, [hora], (err, row) => {
      if (row?.estado === 'pre-reservado') {
        db.run(`UPDATE horas SET estado='reservado', nombre=?, expiracion=NULL WHERE hora=?`,
          [nombre, hora], () => {
            broadcast('estado_actualizado', hora, 'reservado', nombre);
          });
      } else {
        ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Hora no pre-reservada' }));
      }
    });
  } else {
    ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Tipo no reconocido' }));
  }
}

wss.on('connection', ws => {
  console.log('🧩 Cliente WebSocket conectado');
  enviarEstadoInicial(ws);
  ws.on('message', msg => manejarMensaje(ws, msg));
});

console.log(`🟢 WebSocket Server activo en ws://localhost:${WS_PORT}`);
