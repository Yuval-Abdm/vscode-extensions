// Serveurs FTP et SFTP locaux pour les tests d'intégration, servant un dossier temporaire.
const fs = require('fs');
const path = require('path');
const net = require('net');

const USER = 'tester';
const PASSWORD = 'secret';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startFtp(root) {
  const FtpSrv = require('ftp-srv');
  const port = await freePort();
  const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: 30000, pasv_max: 40000, anonymous: false, log: silentLogger() });
  server.on('login', ({ username, password }, resolve, reject) => {
    if (username === USER && password === PASSWORD) resolve({ root });
    else reject(Object.assign(new Error('Bad credentials'), { code: 530 }));
  });
  await server.listen();
  return { port, close: () => server.close() };
}

function silentLogger() {
  const noop = () => {};
  const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => logger };
  return logger;
}

/** Serveur SFTP minimal basé sur ssh2, limité au dossier `root`. */
async function startSftp(root) {
  const { Server, utils } = require('ssh2');
  const { STATUS_CODE } = utils.sftp;
  const port = await freePort();
  const hostKey = utils.generateKeyPairSync('ed25519').private;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('error', () => {});
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), root, STATUS_CODE));
      });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function serveSftp(sftp, root, STATUS_CODE) {
  const { utils } = require('ssh2');
  const handles = new Map();
  let nextHandle = 0;
  const real = (p) => path.join(root, path.posix.normalize('/' + p));
  const newHandle = (value) => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(nextHandle++);
    handles.set(h.toString('hex'), value);
    return h;
  };
  const attrs = (st) => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
  const fail = (reqid, err) => sftp.status(reqid, err?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, err?.message);
  const wrap = (fn) => (reqid, ...args) => {
    try {
      fn(reqid, ...args);
    } catch (err) {
      fail(reqid, err);
    }
  };

  sftp.on('OPEN', wrap((reqid, filename, flags) => {
    const fd = fs.openSync(real(filename), utils.sftp.flagsToString(flags));
    sftp.handle(reqid, newHandle({ fd }));
  }));
  sftp.on('READ', wrap((reqid, handle, offset, length) => {
    const { fd } = handles.get(handle.toString('hex'));
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    if (n === 0) sftp.status(reqid, STATUS_CODE.EOF);
    else sftp.data(reqid, buf.subarray(0, n));
  }));
  sftp.on('WRITE', wrap((reqid, handle, offset, data) => {
    fs.writeSync(handles.get(handle.toString('hex')).fd, data, 0, data.length, offset);
    sftp.status(reqid, STATUS_CODE.OK);
  }));
  sftp.on('FSTAT', wrap((reqid, handle) => sftp.attrs(reqid, attrs(fs.fstatSync(handles.get(handle.toString('hex')).fd)))));
  sftp.on('STAT', wrap((reqid, p) => sftp.attrs(reqid, attrs(fs.statSync(real(p))))));
  sftp.on('LSTAT', wrap((reqid, p) => sftp.attrs(reqid, attrs(fs.lstatSync(real(p))))));
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('CLOSE', wrap((reqid, handle) => {
    const key = handle.toString('hex');
    const h = handles.get(key);
    if (h?.fd !== undefined) fs.closeSync(h.fd);
    handles.delete(key);
    sftp.status(reqid, STATUS_CODE.OK);
  }));
  sftp.on('OPENDIR', wrap((reqid, p) => {
    const dir = real(p);
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    sftp.handle(reqid, newHandle({ dir, done: false }));
  }));
  sftp.on('READDIR', wrap((reqid, handle) => {
    const h = handles.get(handle.toString('hex'));
    if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
    h.done = true;
    const names = fs.readdirSync(h.dir).map((filename) => {
      const st = fs.lstatSync(path.join(h.dir, filename));
      return { filename, longname: filename, attrs: attrs(st) };
    });
    if (!names.length) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.name(reqid, names);
  }));
  sftp.on('MKDIR', wrap((reqid, p) => { fs.mkdirSync(real(p)); sftp.status(reqid, STATUS_CODE.OK); }));
  sftp.on('RMDIR', wrap((reqid, p) => { fs.rmdirSync(real(p)); sftp.status(reqid, STATUS_CODE.OK); }));
  sftp.on('REMOVE', wrap((reqid, p) => { fs.unlinkSync(real(p)); sftp.status(reqid, STATUS_CODE.OK); }));
  sftp.on('RENAME', wrap((reqid, from, to) => { fs.renameSync(real(from), real(to)); sftp.status(reqid, STATUS_CODE.OK); }));
  sftp.on('REALPATH', wrap((reqid, p) => {
    const normalized = path.posix.normalize('/' + p);
    sftp.name(reqid, [{ filename: normalized, longname: normalized, attrs: {} }]);
  }));
}

module.exports = { startFtp, startSftp, USER, PASSWORD };
