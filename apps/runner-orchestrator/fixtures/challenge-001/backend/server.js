// backend/server.js
const express = require("express");
const path = require("path");
const productRoutes = require("./routes/productRoutes");

const app = express();

// Parse JSON request bodies
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, "../frontend")));

// Product API routes
app.use("/api/products", productRoutes);

// Start server if executed directly
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Challenge 001 server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
