/**
 * swagger.js — Add this to server.js to serve Swagger UI
 *
 * npm install swagger-ui-express
 *
 * Then in server.js, after require('dotenv').config(), add:
 *   const { setupSwagger } = require('./swagger');
 *   setupSwagger(app);
 *
 * Then visit: http://localhost:5000/api-docs
 */

const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');

const setupSwagger = (app) => {
  const options = {
    customSiteTitle: 'GOBT Pizza API Docs',
    customCss: `
      .swagger-ui .topbar { background: #0a0a0f; border-bottom: 2px solid #ff6b2b; }
      .swagger-ui .topbar-wrapper img { content: url(''); }
      .swagger-ui .topbar-wrapper::before { content: '🍕 GOBT Pizza API'; color: #ff6b2b; font-size: 20px; font-weight: 700; }
      .swagger-ui .info .title { color: #ff6b2b; }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'none',
      filter: true,
      tryItOutEnabled: true,
    },
  };

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, options));

  // Also serve raw JSON for import into Postman/Insomnia
  app.get('/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerDocument);
  });

  console.log('📖 Swagger UI: http://localhost:' + (process.env.PORT || 5000) + '/api-docs');
  console.log('📄 Swagger JSON: http://localhost:' + (process.env.PORT || 5000) + '/swagger.json');
};

module.exports = { setupSwagger };
