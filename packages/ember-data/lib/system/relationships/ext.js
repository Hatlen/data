import { singularize } from "../../../../ember-inflector/lib/system";
import {
  typeForRelationshipMeta,
  relationshipFromMeta
} from "../relationship-meta";
import { Model } from "../model";

var get = Ember.get;
var set = Ember.set;

/**
  @module ember-data
*/

/*
  This file defines several extensions to the base `DS.Model` class that
  add support for one-to-many relationships.
*/

/**
  @class Model
  @namespace DS
*/
Model.reopen({

  /**
    This Ember.js hook allows an object to be notified when a property
    is defined.

    In this case, we use it to be notified when an Ember Data user defines a
    belongs-to relationship. In that case, we need to set up observers for
    each one, allowing us to track relationship changes and automatically
    reflect changes in the inverse has-many array.

    This hook passes the class being set up, as well as the key and value
    being defined. So, for example, when the user does this:

    ```javascript
    DS.Model.extend({
      parent: DS.belongsTo('user')
    });
    ```

    This hook would be called with "parent" as the key and the computed
    property returned by `DS.belongsTo` as the value.

    @method didDefineProperty
    @param proto
    @param key
    @param value
  */
  didDefineProperty: function(proto, key, value) {
    // Check if the value being set is a computed property.
    if (value instanceof Ember.ComputedProperty) {

      // If it is, get the metadata for the relationship. This is
      // populated by the `DS.belongsTo` helper when it is creating
      // the computed property.
      var meta = value.meta();

      if (meta.isRelationship && meta.kind === 'belongsTo') {
        Ember.addObserver(proto, key, null, 'belongsToDidChange');
        Ember.addBeforeObserver(proto, key, null, 'belongsToWillChange');
      }

      meta.parentType = proto.constructor;
    }
  }
});

/*
  These DS.Model extensions add class methods that provide relationship
  introspection abilities about relationships.

  A note about the computed properties contained here:

  **These properties are effectively sealed once called for the first time.**
  To avoid repeatedly doing expensive iteration over a model's fields, these
  values are computed once and then cached for the remainder of the runtime of
  your application.

  If your application needs to modify a class after its initial definition
  (for example, using `reopen()` to add additional attributes), make sure you
  do it before using your model with the store, which uses these properties
  extensively.
*/

Model.reopenClass({
  /**
    For a given relationship name, returns the model type of the relationship.

    For example, if you define a model like this:

   ```javascript
    App.Post = DS.Model.extend({
      comments: DS.hasMany('comment')
    });
   ```

    Calling `App.Post.typeForRelationship('comments')` will return `App.Comment`.

    @method typeForRelationship
    @static
    @param {String} name the name of the relationship
    @return {subclass of DS.Model} the type of the relationship, or undefined
  */
  typeForRelationship: function(name) {
    var relationship = get(this, 'relationshipsByName').get(name);
    return relationship && relationship.type;
  },

  inverseFor: function(name) {
    var inverseType = this.typeForRelationship(name);

    if (!inverseType) { return null; }

    var options = this.metaForProperty(name).options;

    if (options.inverse === null) { return null; }

    var inverseName, inverseKind, inverse;

    if (options.inverse) {
      inverseName = options.inverse;
      inverse = Ember.get(inverseType, 'relationshipsByName').get(inverseName);

      Ember.assert("We found no inverse relationships by the name of '" + inverseName + "' on the '" + inverseType.typeKey + 
        "' model. This is most likely due to a missing attribute on your model definition.", !Ember.isNone(inverse));

      inverseKind = inverse.kind;
    } else {
      var possibleRelationships = findPossibleInverses(this, inverseType);

      if (possibleRelationships.length === 0) { return null; }

      Ember.assert("You defined the '" + name + "' relationship on " + this + ", but multiple possible inverse relationships of type " + 
        this + " were found on " + inverseType + ". Look at http://emberjs.com/guides/models/defining-models/#toc_explicit-inverses for how to explicitly specify inverses",
        possibleRelationships.length === 1);

      inverseName = possibleRelationships[0].name;
      inverseKind = possibleRelationships[0].kind;
    }

    function findPossibleInverses(type, inverseType, possibleRelationships) {
      possibleRelationships = possibleRelationships || [];

      var relationshipMap = get(inverseType, 'relationships');
      if (!relationshipMap) { return; }

      var relationships = relationshipMap.get(type);
      if (relationships) {
        possibleRelationships.push.apply(possibleRelationships, relationshipMap.get(type));
      }

      if (type.superclass) {
        findPossibleInverses(type.superclass, inverseType, possibleRelationships);
      }

      return possibleRelationships;
    }

    return {
      type: inverseType,
      name: inverseName,
      kind: inverseKind
    };
  },

  /**
    The model's relationships as a map, keyed on the type of the
    relationship. The value of each entry is an array containing a descriptor
    for each relationship with that type, describing the name of the relationship
    as well as the type.

    For example, given the following model definition:

    ```javascript
    App.Blog = DS.Model.extend({
      users: DS.hasMany('user'),
      owner: DS.belongsTo('user'),
      posts: DS.hasMany('post')
    });
    ```

    This computed property would return a map describing these
    relationships, like this:

    ```javascript
    var relationships = Ember.get(App.Blog, 'relationships');
    relationships.get(App.User);
    //=> [ { name: 'users', kind: 'hasMany' },
    //     { name: 'owner', kind: 'belongsTo' } ]
    relationships.get(App.Post);
    //=> [ { name: 'posts', kind: 'hasMany' } ]
    ```

    @property relationships
    @static
    @type Ember.Map
    @readOnly
  */
  relationships: Ember.computed(function() {
    var map = new Ember.MapWithDefault({
      defaultValue: function() { return []; }
    });

    // Loop through each computed property on the class
    this.eachComputedProperty(function(name, meta) {
      // If the computed property is a relationship, add
      // it to the map.
      if (meta.isRelationship) {
        meta.key = name;
        var relationshipsForType = map.get(typeForRelationshipMeta(this.store, meta));

        relationshipsForType.push({
          name: name,
          kind: meta.kind
        });
      }
    });

    return map;
  }).cacheable(false).readOnly(),

  /**
    A hash containing lists of the model's relationships, grouped
    by the relationship kind. For example, given a model with this
    definition:

    ```javascript
    App.Blog = DS.Model.extend({
      users: DS.hasMany('user'),
      owner: DS.belongsTo('user'),

      posts: DS.hasMany('post')
    });
    ```

    This property would contain the following:

    ```javascript
    var relationshipNames = Ember.get(App.Blog, 'relationshipNames');
    relationshipNames.hasMany;
    //=> ['users', 'posts']
    relationshipNames.belongsTo;
    //=> ['owner']
    ```

    @property relationshipNames
    @static
    @type Object
    @readOnly
  */
  relationshipNames: Ember.computed(function() {
    var names = {
      hasMany: [],
      belongsTo: []
    };

    this.eachComputedProperty(function(name, meta) {
      if (meta.isRelationship) {
        names[meta.kind].push(name);
      }
    });

    return names;
  }),

  /**
    An array of types directly related to a model. Each type will be
    included once, regardless of the number of relationships it has with
    the model.

    For example, given a model with this definition:

    ```javascript
    App.Blog = DS.Model.extend({
      users: DS.hasMany('user'),
      owner: DS.belongsTo('user'),

      posts: DS.hasMany('post')
    });
    ```

    This property would contain the following:

    ```javascript
    var relatedTypes = Ember.get(App.Blog, 'relatedTypes');
    //=> [ App.User, App.Post ]
    ```

    @property relatedTypes
    @static
    @type Ember.Array
    @readOnly
  */
  relatedTypes: Ember.computed(function() {
    var type;
    var types = Ember.A();

    // Loop through each computed property on the class,
    // and create an array of the unique types involved
    // in relationships
    this.eachComputedProperty(function(name, meta) {
      if (meta.isRelationship) {
        meta.key = name;
        type = typeForRelationshipMeta(this.store, meta);

        Ember.assert("You specified a hasMany (" + meta.type + ") on " + meta.parentType + " but " + meta.type + " was not found.",  type);

        if (!types.contains(type)) {
          Ember.assert("Trying to sideload " + name + " on " + this.toString() + " but the type doesn't exist.", !!type);
          types.push(type);
        }
      }
    });

    return types;
  }).cacheable(false).readOnly(),

  /**
    A map whose keys are the relationships of a model and whose values are
    relationship descriptors.

    For example, given a model with this
    definition:

    ```javascript
    App.Blog = DS.Model.extend({
      users: DS.hasMany('user'),
      owner: DS.belongsTo('user'),

      posts: DS.hasMany('post')
    });
    ```

    This property would contain the following:

    ```javascript
    var relationshipsByName = Ember.get(App.Blog, 'relationshipsByName');
    relationshipsByName.get('users');
    //=> { key: 'users', kind: 'hasMany', type: App.User }
    relationshipsByName.get('owner');
    //=> { key: 'owner', kind: 'belongsTo', type: App.User }
    ```

    @property relationshipsByName
    @static
    @type Ember.Map
    @readOnly
  */
  relationshipsByName: Ember.computed(function() {
    var map = Ember.Map.create();

    this.eachComputedProperty(function(name, meta) {
      if (meta.isRelationship) {
        meta.key = name;
        var relationship = relationshipFromMeta(this.store, meta);
        relationship.type = typeForRelationshipMeta(this.store, meta);
        map.set(name, relationship);
      }
    });

    return map;
  }).cacheable(false).readOnly(),

  /**
    A map whose keys are the fields of the model and whose values are strings
    describing the kind of the field. A model's fields are the union of all of its
    attributes and relationships.

    For example:

    ```javascript

    App.Blog = DS.Model.extend({
      users: DS.hasMany('user'),
      owner: DS.belongsTo('user'),

      posts: DS.hasMany('post'),

      title: DS.attr('string')
    });

    var fields = Ember.get(App.Blog, 'fields');
    fields.forEach(function(field, kind) {
      console.log(field, kind);
    });

    // prints:
    // users, hasMany
    // owner, belongsTo
    // posts, hasMany
    // title, attribute
    ```

    @property fields
    @static
    @type Ember.Map
    @readOnly
  */
  fields: Ember.computed(function() {
    var map = Ember.Map.create();

    this.eachComputedProperty(function(name, meta) {
      if (meta.isRelationship) {
        map.set(name, meta.kind);
      } else if (meta.isAttribute) {
        map.set(name, 'attribute');
      }
    });

    return map;
  }).readOnly(),

  /**
    Given a callback, iterates over each of the relationships in the model,
    invoking the callback with the name of each relationship and its relationship
    descriptor.

    @method eachRelationship
    @static
    @param {Function} callback the callback to invoke
    @param {any} binding the value to which the callback's `this` should be bound
  */
  eachRelationship: function(callback, binding) {
    get(this, 'relationshipsByName').forEach(function(name, relationship) {
      callback.call(binding, name, relationship);
    });
  },

  /**
    Given a callback, iterates over each of the types related to a model,
    invoking the callback with the related type's class. Each type will be
    returned just once, regardless of how many different relationships it has
    with a model.

    @method eachRelatedType
    @static
    @param {Function} callback the callback to invoke
    @param {any} binding the value to which the callback's `this` should be bound
  */
  eachRelatedType: function(callback, binding) {
    get(this, 'relatedTypes').forEach(function(type) {
      callback.call(binding, type);
    });
  }
});

Model.reopen({
  /**
    Given a callback, iterates over each of the relationships in the model,
    invoking the callback with the name of each relationship and its relationship
    descriptor.

    @method eachRelationship
    @param {Function} callback the callback to invoke
    @param {any} binding the value to which the callback's `this` should be bound
  */
  eachRelationship: function(callback, binding) {
    this.constructor.eachRelationship(callback, binding);
  }
});
