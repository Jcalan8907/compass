const Reflux = require('reflux');

/**
 * Sets global collection information.
 */
const CollectionStore = Reflux.createStore({

  /**
   * Initialize the store.
   */
  init() {
    this.collection = {};
    this.activeTabIndex = 0;
  },

  /**
   * Handle app registry activation.
   *
   * @param {AppRegistry} appRegistry - The app registry.
   */
  onActivated(appRegistry) {
    this.appRegistry = appRegistry;
    appRegistry.on('data-service-disconnected', this.onDisconnected.bind(this));
    appRegistry.on('show-agg-pipeline-out-results', (ns) => {
      this.setCollection({
        _id: ns,
        readonly: false,
        capped: false,
        isCustomCollation: false
      });
      this.setActiveTab(0);
    });
  },

  onDisconnected() {
    this.collection = {};
    this.activeTabIndex = 0;
  },

  /**
   * Set the collection information.
   *
   * @param {Object} collection - The collection info.
   */
  setCollection(collection) {
    const nsStore = global.hadronApp.appRegistry.getStore('App.NamespaceStore');
    this.collection = collection;
    if (collection._id) {
      nsStore.ns = collection._id;
    }
  },

  /**
   * Set the active tab idx for the current collection
   * @param {number} idx current tab idx
   */
  setActiveTab(idx) {
    this.activeTabIndex = idx;
    this.trigger(idx);
  },

  /**
   * Get the active tab idx for the current collection
   * @returns {number} the current idx
   */
  getActiveTab() {
    return this.activeTabIndex;
  },

  /**
   * Get the collection ns.
   *
   * @returns {String} The collection ns.
   */
  ns() {
    return this.collection._id;
  },

  /**
   * Is the collection readonly?
   *
   * @returns {Boolean} If the collection is readonly.
   */
  isReadonly() {
    return this.collection.readonly;
  }
});

module.exports = CollectionStore;
