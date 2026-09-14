// // backend/controllers/productController.js
// const productsData = require("../data/products");

// // GET /api/products
// function getProducts(req, res) {
//   const products = productsData.getAll();
//   return res.status(200).json(products);
// }

// // POST /api/products
// function createProduct(req, res) {
//   const { name, price, tags } = req.body;

//   // -------------------------------------------------------------
//   // BUG 2: Tag validation is missing or faulty!
//   // Candidate task: Ensure `tags` is an array and has at least 3 tags.
//   // If not, return status 400 with:
//   //   { "error": "At least 3 tags are required" }
//   // -------------------------------------------------------------

//   // -------------------------------------------------------------
//   // BUG 1: Returns status 200 and incorrect body!
//   // Candidate task: Should return status 201 (Created) along with
//   // the full created product object: { id, name, price, tags }
//   // -------------------------------------------------------------
//   productsData.add({ name, price, tags });

//   return res.status(200).json({ success: true });
// }

// // DELETE /api/products/:id
// function deleteProduct(req, res) {
//   const { id } = req.params;

//   // -------------------------------------------------------------
//   // BUG 3: Accidentally wipes out all products instead of deleting
//   // only the matching ID, and does not handle 404 when ID is missing!
//   // Candidate task:
//   // 1. If product does not exist, return 404 with:
//   //    { "error": "Product not found" }
//   // 2. If product exists, permanently delete ONLY that product and
//   //    return 200 with:
//   //    { "message": "Product deleted successfully" }
//   // -------------------------------------------------------------
//   productsData.deleteAll();

//   return res.status(200).json({ message: "Product deleted successfully" });
// }

// module.exports = {
//   getProducts,
//   createProduct,
//   deleteProduct,
// };

// backend/controllers/productController.js
const productsData = require("../data/products");

// GET /api/products
function getProducts(req, res) {
  const products = productsData.getAll();

  return res.status(200).json(products);
}

// POST /api/products
function createProduct(req, res) {
  const { name, price, tags } = req.body;

  // Validate tags
  if (!Array.isArray(tags) || tags.length < 3) {
    return res.status(400).json({
      error: "At least 3 tags are required",
    });
  }

  // Create product
  const createdProduct = productsData.add({
    name,
    price,
    tags,
  });

  return res.status(201).json(createdProduct);
}

// DELETE /api/products/:id
function deleteProduct(req, res) {
  const { id } = req.params;

  // Check whether product exists
  const product = productsData.findById(id);

  if (!product) {
    return res.status(404).json({
      error: "Product not found",
    });
  }

  // Delete only the requested product
  productsData.deleteById(id);

  return res.status(200).json({
    message: "Product deleted successfully",
  });
}

module.exports = {
  getProducts,
  createProduct,
  deleteProduct,
};