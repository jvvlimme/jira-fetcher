require('dotenv').config();
//require("lambda")
var http = require("request"),
    _ = require("lodash"),
    async = require("async"),
    moment = require('moment'),
    elasticsearch = require('elasticsearch'),
    elastic = new elasticsearch.Client({
        host: process.env.ES
    })
    express = require("express"),
    app = express();
    var bodyParser = require('body-parser');
    app.use(bodyParser.json()); // support json encoded bodies
    app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies


// App setup

const filter = process.env.FILTER;
const apiuser = process.env.APIUSER;
const apipass = process.env.APIPASS;
const jira = process.env.JIRA;

var issues = [],
    defaultFields = {
        "index": "stories",
        "type": "stories",
        "body": {}
    }

var teamStatuses = ["Backlog", "Awaiting Development", "Done", "In Progress", "Awaiting Code Review", "In code review", "Awaiting QA Dev", "In QA Dev", "Awaiting UAT"]
var leadStatuses = ["In Progress", "Awaiting Code Review", "In code review", "Awaiting QA Dev", "In QA Dev", "Awaiting UAT"]
var prodStatuses = ["In Progress", "In code review", "In QA Dev"]

var fetchIssues = function (jql, qType, gnext) {

    var url = "https://" + apiuser + ":" + apipass + "@" + jira + "/search?expand=changelog&maxResults=1000&jql=" + jql
    console.log(url);
    http(url, function (err, response, body) {
        //console.log(body);
        if (err) console.log(err);
        var body = JSON.parse(body);
        //console.log(body);
        var l = {};
        async.map(body.issues, function (issue, cb) {
            var x = {}
            x.key = issue.key;
            //console.log(x.key)
            x.issueType = issue.fields.issuetype.name;
            x.status = issue.fields.status.statusCategory.name;
            x.realStatus = issue.fields.status.name
            x.epic = issue.fields.customfield_10800;
            x.labels = issue.fields.labels;
            if (issue.fields.resolution) x.resolution = issue.fields.resolution.name;
            x.description = issue.fields.summary;
            x.title = issue.fields.customfield_10801;
            x.sp = issue.fields.customfield_10105 || 0;
            if (issue.fields.fixVersions.length > 0) {
                x.releaseDate = issue.fields.fixVersions[0].releaseDate;
                x.releaseName = issue.fields.fixVersions[0].name
            }
            x.history = []
            x.lead = 0;
            x.prod = 0;
            var y = {}
            y.status = "Created";
            y.dt = issue.fields.created;
            x.history.push(y);

            // Map Histories

            var historyItems = issue.changelog.histories.map(function (history) {
                var filterStatus = history.items.filter(function (historyItem) {
                    return (historyItem.field == "status")
                })
                filterStatus.forEach(function (fs) {
                    y = {}
                    y.status = fs.toString;
                    y.dt = history.created;
                    x.history.push(y)
                    return;
                })
                return;
            })

            x.history.forEach(function (historyItem, index) {

                var start = moment(historyItem.dt);
                var end = (typeof(x.history[index + 1]) == "undefined") ? moment() : moment(x.history[index + 1].dt);

                // We don't want to count weekends
                var weekendCounter = 0;
                var start2 = start;
                while (start2 <= end) {

                    if (start.format('ddd') == 'Sat' || start.format('ddd') == 'Sun') {
                        weekendCounter++; //add 1 to your counter if its not a weekend day
                    }
                    start2.add(1, "days");
                }
                x.history[index].duration = moment.duration(end.diff(moment(historyItem.dt))).asSeconds()
                x.history[index].start = moment(historyItem.dt);
                x.history[index].end = end;
                x.history[index].weekendDays = weekendCounter

                if (_.includes(leadStatuses, historyItem.status)) {
                    x.lead += x.history[index].duration;
                }
                x.lead = parseInt(x.lead)
                if (_.includes(prodStatuses, historyItem.status)) {
                    x.prod += x.history[index].duration
                }
                x.prod = parseInt(x.prod)
            })

            var statusHistory = {};
             x.history.map(function (item) {
                if (!statusHistory[item.status]) {
                    statusHistory[item.status] = {};
                    statusHistory[item.status].duration = 0;
                }
                statusHistory[item.status].duration += (item.duration || 0);
                return;
            })
            var durationPerStatus = [];
            x.durationPerStatusFlat = {}
            Object.keys(statusHistory).forEach(function (item) {
                var y = {}
                y.label = item;
                y.duration = parseInt(statusHistory[item].duration);
                //x.durationPerStatusFlat[item.replace(/ /g, "_")] = parseInt(statusHistory[item].duration)
                durationPerStatus.push(y);
            })
            durationPerStatus.forEach(function (element) {
                if (element.label.indexOf(leadStatuses) > -1) {
                    x.lead += element.duration;
                }
            })
            x.lead = parseInt(moment.duration(x.lead, "seconds").asDays().toFixed(2))
            //x.prod = moment.duration(x.prod, "seconds").asDays().toFixed(2)
            cb(null, x)
        }, function (err, items) {
            //gnext(items);
            // Push items to ES here
            items.forEach(function (i) {
                //console.log(i.key)
                elastic.index({
                    index: "stories",
                    type: qType || "pg_ongoing",
                    id: i.key,
                    body: i
                }, function (err, r) {
                    //if (err) console.log(err);
                })
            });

            // Add to epic
            async.map(items, function (i, next) {
                if (!l[i.epic]) {
                    l[i.epic] = []
                }
                l[i.epic].push(i);

                next(null, i)
            }, function (err, r) {
                issues = l;
                gnext(l);
            })
        });
    });
}

var fetchOngoing = function() {
    var jql = "filter = 23577 and (status not in (Done, Closed, Solved)  OR (resolved >=  startOfDay('-14d'))) and issuetype not in ('UX', 'Problem', 'Service Request', 'Follow Up')"
    var qType = "pg_ongoing";
    defaultFields.type = "pg_ongoing"
    defaultFields.body = {query: {match_all: {}}}
    console.log("Fetching", moment().format())
    fetchIssues(jql, qType, function (items) {
        console.log("Fetched", moment().format())
        return
    })
}

fetchOngoing();

var fetchHistory = function() {
    var jql = "filter = 23577 and created >= startOfYear(-1) and issuetype not in  ('UX', 'Problem', 'Service Request', 'Follow Up')"
    var qType = "pg_ongoing";
    defaultFields.type = "pg_ongoing"
    defaultFields.body = {query: {match_all: {}}}
    console.log("Fetching", moment().format())
    fetchIssues(jql, qType, function (items) {
        console.log("Fetched", moment().format())
        return
    })
}

fetchHistory()

module.exports = app
