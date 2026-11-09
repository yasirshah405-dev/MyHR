const fs = require('fs');

module.exports = ({ config }) => {
  const localGoogleServices = fs.existsSync('./google-services.json') ? './google-services.json' : undefined;
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || localGoogleServices;
  return {
    ...config,
    android: {
      ...(config.android || {}),
      ...(googleServicesFile ? { googleServicesFile } : {})
    }
  };
};
