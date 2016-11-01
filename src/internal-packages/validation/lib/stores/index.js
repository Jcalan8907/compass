const Reflux = require('reflux');
const ValidationActions = require('../actions');
const StateMixin = require('reflux-state-mixin');
const _ = require('lodash');
const uuid = require('uuid');
const ruleCategories = require('../components/rule-categories');
const helper = require('./helpers');
const toNS = require('mongodb-ns');
const app = require('ampersand-app');

// stores
const NamespaceStore = require('hadron-reflux-store').NamespaceStore;

const debug = require('debug')('mongodb-compass:stores:validation');

/**
 * Validation store.
 */

const ValidationStore = Reflux.createStore({
  /**
   * adds a state to the store, similar to React.Component's state
   * @see https://github.com/yonatanmn/Super-Simple-Flux#reflux-state-mixin
   */
  mixins: [StateMixin.store],

  /**
   * listen to all actions defined in ../actions/index.jsx
   */
  listenables: ValidationActions,

  /**
   * Initialize everything that is not part of the store's state.
   */
  init() {
    this.lastFetchedValidatorDoc = {};

    NamespaceStore.listen(() => {
      debug('new namespace');
      ValidationActions.fetchValidationRules();
    });
  },

  /**
   * Initialize the Validation store state.
   *
   * @return {Object} initial store state.
   */
  getInitialState() {
    return {
      viewMode: 'Rule Builder',    // one of `Rule Builder`, `JSON`
      validatorDoc: {},            // the validator doc fetched from the server
      validationRules: [],         // array of rules as defined below
      validationLevel: 'off',      // one of `off`, `moderate`, `strict`
      validationAction: 'warn',    // one of `warn`, `error`
      fetchState: 'initial',       // one of `initial`, `fetching`, `success`, `error`
      editState: 'unmodified',     // one of `unmodified`, `modified`, `updating`, `success`, `error`
      isExpressibleByRules: true   // boolean
    };
  },

  /**
   * takes a validator document and constructs individual rules if possible.
   *
   * If the validatorDoc format is incorrect, returns false. Otherwise returns
   * an Object with keys `rules`, `validationLevel` and `validationAction`.
   *
   * If the validator doc can be expressed as rules, the `rules` value is
   * an array of rules, otherwise it is `false`.
   *
   * @param {Object} validatorDoc   object to extract rules from.
   *
   * @return {Object|Boolean}  false if error encountered, otherwise an object
   *                           of rules, validationLevel, validationAction
   *                           (see above).
   */
  _deconstructValidatorDoc(validatorDoc) {
    if (!_.has(validatorDoc, 'validator')) {
      // no validator doc present, create an empty doc
      validatorDoc.validator = {};
    }

    const validator = helper.filterAndFromValidator(validatorDoc.validator);

    const rules = _.map(validator, (field) => {
      const fieldName = field[0];
      const rule = field[1];
      debug('structure of field is:', field);
      debug('rule is:', rule);
      debug('fieldName is:', fieldName);

      let parameters;
      const result = helper.nullableOrValidator(fieldName, rule);

      const category = _.findKey(ruleCategories, (cat) => {
        parameters = cat.queryToParams(result.value);
        return parameters;
      });
      // no rule category could be found to express this rule
      if (!category) {
        return false;
      }
      return {
        id: uuid.v4(),
        field: result.field,
        category: category,
        parameters: parameters,
        nullable: result.nullable
      };
    });
    if (!_.every(rules)) {
      return {
        rules: false,
        level: _.get(validatorDoc, 'validationLevel', 'off'),
        action: _.get(validatorDoc, 'validationAction', 'warn')
      };
    }
    return {
      rules: rules,
      level: _.get(validatorDoc, 'validationLevel', 'off'),
      action: _.get(validatorDoc, 'validationAction', 'warn')
    };
  },

  /**
   * Takes individual rules or a validatorDoc, validationLevel and
   * validationAction and returns a complete validatorDoc.
   *
   * @param {Object} params  an object containing the fields `rules`, `level`,
   *                         and `action`:
   *                         rules:  array of rules, or false if validatorDoc
   *                                 is not expressible as rules.
   *                         level:  one of `off`, `moderate`, `strict`
   *                         action: one of `warn`, `error`
   *
   * @returns {Object}   a validatorDoc that can be sent back to the server.
   */
  _constructValidatorDoc(params) {
    let validator;
    let hasMultipleNulls;
    if (params.rules) {
      hasMultipleNulls = helper.hasMultipleNullables(params.rules);
      if (hasMultipleNulls) {
        validator = _(params.rules)
          .map((rule) => {
            let field = rule.field;
            let value = rule.category ?
              ruleCategories[rule.category].paramsToQuery(rule.parameters) :
              {};
            if (rule.nullable) {
              value = helper.nullableOrQueryWrapper(value, field);
              field = '$or';
            }
            const wrapper = {};
            wrapper[field] = value;
            return wrapper;
          })
          .value();
      } else {
        validator = _(params.rules)
          .map((rule) => {
            let field = rule.field;
            let value = rule.category ?
              ruleCategories[rule.category].paramsToQuery(rule.parameters) :
              {};
            if (rule.nullable) {
              value = helper.nullableOrQueryWrapper(value, field);
              field = '$or';
            }
            return [field, value];
          })
          .zipObject()
          .value();
      }

      if (hasMultipleNulls) {
        validator = {'$and': validator};
      }
    } else {
      validator = this.state.validatorDoc.validator;
    }
    return {
      validator: validator,
      validationLevel: params.level,
      validationAction: params.action
    };
  },

  /**
   * After any of the rules are modified through one of the actions below,
   * compute the new validatorDoc and compare it to the last fetched one.
   * Store the new rules in the state along with the editState and update
   * validatorDoc.
   *
   * This function modifies the state!
   *
   * @param {Object} params   object containing the fields `rules`, `level`,
   *                          `action`. Uses the state values as defaults.
   */
  _updateState(params) {
    params = _.defaults(params, {
      rules: this.state.validationRules,
      level: this.state.validationLevel,
      action: this.state.validationAction
    });

    // update current validatorDoc and compare to last fetched one
    const validatorDoc = this._constructValidatorDoc(params);

    this.setState({
      validatorDoc: validatorDoc,
      validationRules: params.rules,
      validationLevel: params.level,
      validationAction: params.action,
      isExpressibleByRules: _.isArray(params.rules),
      editState: _.isEqual(this.lastFetchedValidatorDoc, validatorDoc) ?
        'unmodified' : 'modified'
    });
  },

  /**
   * fetches the validator doc from the server (async).
   *
   * @todo replace with actual dataService call
   *
   * @param {Function} callback   function to call with (err, res) from server.
   */
  _fetchFromServer(callback) {
    const ns = toNS(NamespaceStore.ns);
    app.dataService.listCollections(ns.database, {name: ns.collection}, function(err, res) {
      if (err) {
        return callback(err);
      }
      callback(null, res[0]);
    });
  },

  fetchValidationRules() {
    this.setState({
      fetchState: 'fetching'
    });
    this._fetchFromServer((err, res) => {
      debug('result from server', err, res);
      if (err || !_.has(res, 'options')) {
        // an error occured during fetch, e.g. missing permissions
        this.setState({
          fetchState: 'error'
        });
        return;
      }
      const result = this._deconstructValidatorDoc(res.options);

      // store result from server
      this.lastFetchedValidatorDoc = this._constructValidatorDoc(result);
      const validatorDoc = _.clone(this.lastFetchedValidatorDoc);

      if (!result) {
        // the validatorDoc has an unexpected format.
        this.setState({
          fetchState: 'error'
        });
        return;
      }

      if (!_.isPlainObject(result)) {
        // the return value is not falsey but also not an object. This should
        // never happen!
        this.setState({
          fetchState: 'error'
        });
        return;
      }

      if (!result.rules) {
        // the validatorDoc cannot be expressed as simple rules.
        this.setState({
          fetchState: 'success',
          isExpressibleByRules: false,
          validatorDoc: validatorDoc,
          validationLevel: result.level,
          validationAction: result.action,
          editState: 'unmodified'
        });
        return;
      }

      // the validator Doc _can_ be expressed as simple rules.
      this.setState({
        fetchState: 'success',
        isExpressibleByRules: true,
        validatorDoc: validatorDoc,
        validationRules: result.rules,
        validationLevel: result.level,
        validationAction: result.action,
        editState: 'unmodified'
      });
    });
  },

  addValidationRule() {
    const rules = _.clone(this.state.validationRules);
    const id = uuid.v4();
    rules.push({
      id: id,
      field: '',
      category: '',
      parameters: {},
      nullable: false
    });

    this._updateState({rules: rules});
  },

  deleteValidationRule(id) {
    const rules = _.clone(this.state.validationRules);
    const ruleIndex = _.findIndex(rules, 'id', id);
    rules.splice(ruleIndex, 1);

    this._updateState({rules: rules});
  },

  setRuleField(id, field) {
    const rules = _.clone(this.state.validationRules);
    const ruleIndex = _.findIndex(rules, 'id', id);
    rules[ruleIndex].field = field;

    this._updateState({rules: rules});
  },

  setRuleCategory(id, category) {
    const rules = _.clone(this.state.validationRules);
    const ruleIndex = _.findIndex(rules, 'id', id);
    if (category !== rules[ruleIndex].category &&
      _.includes(_.keys(ruleCategories), category)) {
      rules[ruleIndex].category = category;
      rules[ruleIndex].parameters = ruleCategories[category].getInitialParameters();

      this._updateState({rules: rules});
    }
  },

  setRuleParameters(id, params) {
    const rules = _.clone(this.state.validationRules);
    const ruleIndex = _.findIndex(rules, 'id', id);
    rules[ruleIndex].parameters = params;

    this._updateState({rules: rules});
  },

  setRuleNullable(id, value) {
    if (!id || !_.isBoolean(value)) {
      return;
    }
    const rules = _.clone(this.state.validationRules);
    const ruleIndex = _.findIndex(rules, 'id', id);
    rules[ruleIndex].nullable = value;

    this._updateState({rules: rules});
  },

  setValidationAction(validationAction) {
    if (_.includes(['warn', 'error'], validationAction)) {
      this._updateState({action: validationAction});
    }
  },

  setValidationLevel(validationLevel) {
    if (_.includes(['off', 'moderate', 'strict'], validationLevel)) {
      this._updateState({level: validationLevel});
    }
  },

  /**
   * switches the view mode between `Rule Builder` and `JSON`.
   *
   * @param {String} viewMode   one of `Rule Builder`, `JSON`.
   */
  switchView(viewMode) {
    if (_.includes(['Rule Builder', 'JSON'], viewMode)) {
      this.setState({
        viewMode: viewMode
      });
    }
  },

  cancelChanges() {
    const params = this._deconstructValidatorDoc(this.lastFetchedValidatorDoc);
    this._updateState(params);
  },

  saveChanges() {
    debug('Sending new validator doc to server:', this.state.validatorDoc);
    this.setState({
      editState: 'updating'
    });
    app.dataService.updateCollection(NamespaceStore.ns, this.state.validatorDoc, (err) => {
      if (err) {
        this.setState({
          editState: 'error'
        });
        return;
      }
      this.setState({
        editState: 'success'
      });
      setTimeout(() => {
        this.lastFetchedValidatorDoc = _.clone(this.state.validatorDoc);
        this.setState({
          editState: 'unmodified'
        });
      }, 1000);
    });
  },

  /**
   * log changes to the store as debug messages.
   * @param  {Object} prevState   previous state.
   */
  storeDidUpdate(prevState) {
    debug('Validation store changed from', prevState, 'to', this.state);
  }
});

module.exports = ValidationStore;