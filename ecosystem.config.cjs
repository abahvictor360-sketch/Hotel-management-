module.exports = {
  apps: [
    {
      name: "hotel-hub",
      script: "apps/api/src/server.ts",
      interpreter: "node",
      node_args: "--import tsx",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      time: true,
      kill_timeout: 15000,
    },
  ],
};
