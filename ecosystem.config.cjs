module.exports = {
  apps: [
    {
      name: 'antigpt',
      script: 'server/server.js',
      cwd: '/opt/2009/anti',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
