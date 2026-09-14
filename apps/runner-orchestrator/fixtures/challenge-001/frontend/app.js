// frontend/app.js

document.addEventListener("DOMContentLoaded", () => {
  const productForm = document.getElementById("productForm");
  const productsGrid = document.getElementById("productsGrid");
  const productCount = document.getElementById("productCount");
  const formFeedback = document.getElementById("formFeedback");
  const refreshBtn = document.getElementById("refreshBtn");

  // Load products on initial render
  fetchProducts();

  // Handle Form Submit
  productForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFeedback();

    const name = document.getElementById("productName").value.trim();
    const price = parseFloat(document.getElementById("productPrice").value);
    const rawTags = document.getElementById("productTags").value;

    const tags = rawTags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const payload = { name, price, tags };

    try {
      const response = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.status === 201) {
        showFeedback("Product created successfully (201 Created)!", "success");
        productForm.reset();
        fetchProducts();
      } else if (response.status === 400) {
        showFeedback(data.error || "Bad Request (400)", "error");
      } else {
        showFeedback(
          `Unexpected response status ${response.status}: ${JSON.stringify(data)}`,
          "error"
        );
      }
    } catch (err) {
      showFeedback(`Network error: ${err.message}`, "error");
    }
  });

  // Handle Refresh Button
  refreshBtn.addEventListener("click", () => {
    fetchProducts();
  });

  // Fetch and display all products
  async function fetchProducts() {
    try {
      const response = await fetch("/api/products");
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      const products = await response.json();
      renderProducts(products);
    } catch (err) {
      productsGrid.innerHTML = `
        <div class="empty-state">
          <p class="empty-state-title">Unable to load products</p>
          <p>${err.message}</p>
        </div>
      `;
      productCount.textContent = "0";
    }
  }

  // Render product cards
  function renderProducts(products) {
    productCount.textContent = products.length;

    if (!Array.isArray(products) || products.length === 0) {
      productsGrid.innerHTML = `
        <div class="empty-state">
          <p class="empty-state-title">No products found</p>
          <p>Create a product using the form or refresh the list.</p>
        </div>
      `;
      return;
    }

    productsGrid.innerHTML = products
      .map((product) => {
        const tags = Array.isArray(product.tags) ? product.tags : [];
        const tagsHtml = tags
          .map((tag) => `<span class="tag-pill">#${escapeHtml(tag)}</span>`)
          .join("");

        return `
          <div class="product-item" data-id="${escapeHtml(String(product.id))}">
            <div class="product-info">
              <div class="product-title-row">
                <span class="product-id-tag">#${escapeHtml(String(product.id))}</span>
                <span class="product-name">${escapeHtml(product.name || "Unnamed Product")}</span>
                <span class="product-price">$${Number(product.price || 0).toFixed(2)}</span>
              </div>
              <div class="product-tags">
                ${tagsHtml || '<span class="form-hint">No tags</span>'}
              </div>
            </div>
            <button 
              class="btn btn-danger-outline delete-btn" 
              data-id="${escapeHtml(String(product.id))}"
              title="Delete product #${escapeHtml(String(product.id))}"
            >
              Delete
            </button>
          </div>
        `;
      })
      .join("");

    // Attach delete listeners
    document.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const id = e.currentTarget.getAttribute("data-id");
        await deleteProduct(id);
      });
    });
  }

  // Delete product action
  async function deleteProduct(id) {
    try {
      const response = await fetch(`/api/products/${id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (response.status === 200) {
        showFeedback(data.message || `Product #${id} deleted`, "success");
        fetchProducts();
      } else if (response.status === 404) {
        showFeedback(data.error || "Product not found (404)", "error");
      } else {
        showFeedback(`Failed to delete product (Status ${response.status})`, "error");
      }
    } catch (err) {
      showFeedback(`Network error: ${err.message}`, "error");
    }
  }

  function showFeedback(message, type) {
    formFeedback.textContent = message;
    formFeedback.className = `feedback-banner ${type}`;
  }

  function clearFeedback() {
    formFeedback.textContent = "";
    formFeedback.className = "feedback-banner hidden";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
});
